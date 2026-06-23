#!/usr/bin/env bun
/**
 * Phase 8a verification — JSONL round-trip and resume fold.
 * Run: bun run pi-plugin/rlm/test/phase8-state.ts
 */

import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, generateRunId, reconstructRlmState, runDir } from "../src/state/index.ts";
import type { RunHeader, TurnRow, CompactionRow } from "../src/state/rows.ts";
import { STATE_SCHEMA_VERSION } from "../src/state/rows.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase8-state-"));
  const cwd = tmp;
  const dir = ".rlm/runs";
  const runId = generateRunId();
  const systemPrompt = "You are a test RLM.";

  try {
    const header: RunHeader = {
      kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: new Date().toISOString(),
      rootPrompt: "test prompt",
      context: { type: "str", chars: 0, json: false, projectMap: false },
      workspaceRoot: cwd,
      models: { smart: "deepseek/deepseek-v4-pro", worker: "deepseek/deepseek-v4-flash" },
      meta: { maxIterations: 30, maxDepth: 2, orchestrator: true, editEnabled: false, fsTools: false },
    };
    check("header written", appendRow(cwd, dir, runId, header));

    const t1: TurnRow = { kind: "turn", turn: 1, ts: new Date().toISOString(), response: "Let me check.", replOutputs: "[block 1]\nlist 3", error: false, usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 50 }, cumulativeDurationMs: 1000, snapshotOk: true };
    check("turn 1 appended", appendRow(cwd, dir, runId, t1));
    const t2: TurnRow = { kind: "turn", turn: 2, ts: new Date().toISOString(), response: "Found something.", replOutputs: "[block 1]\nsome output", answerContent: "partial", edits: [{ path: "a.ts", oldText: "old", newText: "new" }], error: false, usage: { costUsd: 0.02, inputTokens: 200, outputTokens: 100 }, cumulativeDurationMs: 2500, snapshotOk: true };
    check("turn 2 appended", appendRow(cwd, dir, runId, t2));
    const t3: TurnRow = { kind: "turn", turn: 3, ts: new Date().toISOString(), response: "Final answer.", replOutputs: "[block 1]\nfinal output", answerContent: "THE ANSWER", error: false, usage: { costUsd: 0.03, inputTokens: 150, outputTokens: 75 }, cumulativeDurationMs: 5000, snapshotOk: false };
    check("turn 3 appended", appendRow(cwd, dir, runId, t3));

    const comp: CompactionRow = { kind: "compaction", turn: 3, ts: new Date().toISOString(), history: [{ role: "system", content: systemPrompt }, { role: "assistant", content: "Summary." }, { role: "user", content: "Continue." }], usage: { costUsd: 0.005, inputTokens: 80, outputTokens: 20 } };
    check("compaction appended", appendRow(cwd, dir, runId, comp));

    const recon = reconstructRlmState(cwd, dir, runId, systemPrompt);
    check("fold ok", recon.ok);
    if (recon.ok) {
      check("completedTurns = 3", recon.completedTurns === 3, String(recon.completedTurns));
      check("history rebuilt", recon.history.length >= 3);
      check("history starts with system", recon.history[0].role === "system");
      const expectedCost = 0.01 + 0.02 + 0.03 + 0.005;
      check("usageSeed cost", Math.abs(recon.usageSeed.costUsd - expectedCost) < 0.0001);
      check("usageSeed durationMs from last turn", recon.usageSeed.durationMs === 5000); // CA: seeds LimitGuard clock
      check("best = turn 3 answerContent", recon.best === "THE ANSWER");
      check("edits from turn 2", recon.editsAcc.length === 1 && recon.editsAcc[0].path === "a.ts");
      check("snapshotTurn undefined (no pkl on disk)", recon.snapshotTurn === undefined); // R-C1: verifies file existence, not just row flag
      check("compactions = 1", recon.compactions === 1);
    }

    // Corrupt trailing line — tolerated
    appendFileSync(join(runDir(cwd, dir, runId), "trail.jsonl"), "{ broken\n", "utf-8");
    const recon2 = reconstructRlmState(cwd, dir, runId, systemPrompt);
    check("trailing garbage tolerated", recon2.ok);

    // Version mismatch
    const runId2 = generateRunId();
    const headerV999: RunHeader = { ...header, v: 999, runId: runId2 };
    appendRow(cwd, dir, runId2, headerV999);
    const recon3 = reconstructRlmState(cwd, dir, runId2, systemPrompt);
    check("version mismatch fails", !recon3.ok && recon3.reason === "version-mismatch");

    // No header
    const runId3 = generateRunId();
    const recon4 = reconstructRlmState(cwd, dir, runId3, systemPrompt);
    check("no header fails", !recon4.ok && recon4.reason === "no-header");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
