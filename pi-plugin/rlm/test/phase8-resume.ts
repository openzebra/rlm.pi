#!/usr/bin/env bun
/**
 * Phase 8c verification — live kill → resume smoke test.
 *
 * Simulates: a 2-turn run crashes after writing turn rows + per-turn snapshots.
 * Then resume reconstructs state, restores the sandbox, and asserts:
 *   - REPL vars survive (sandbox restore from the correct per-turn file)
 *   - Context is non-empty (sidecar reload)
 *   - Usage seeds carry over (cost/tokens/duration)
 *   - Per-turn fallback works (R-C1: if latest snapshot missing, falls back to prior turn)
 *   - Pickle trust guard rejects non-RLM files
 *
 * Run: bun run pi-plugin/rlm/test/phase8-resume.ts
 * Requires: python3 on PATH
 */

import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import {
  appendRow,
  generateRunId,
  reconstructRlmState,
  runDir,
  snapshotPath,
  writeContextSidecar,
} from "../src/state/index.ts";
import { STATE_SCHEMA_VERSION } from "../src/state/rows.ts";
import type { RunHeader, TurnRow } from "../src/state/rows.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase8-resume-"));
  const cwd = tmp;
  const dir = ".rlm/runs";
  const runId = generateRunId();
  const contextText = "This is the original context with important data.";

  try {
    // --- Write the trail header + context sidecar FIRST (creates the run dir, matching engine flow) ---
    const header: RunHeader = {
      kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: new Date().toISOString(),
      rootPrompt: "test resume prompt",
      context: { type: "str", chars: contextText.length, json: false, projectMap: false },
      workspaceRoot: cwd,
      models: { smart: "test/smart", worker: "test/worker" },
      meta: { maxIterations: 30, maxDepth: 2, orchestrator: true, editEnabled: false, fsTools: false },
    };
    check("header written", appendRow(cwd, dir, runId, header));
    check("context sidecar written", writeContextSidecar(cwd, dir, runId, contextText, false));

    // --- Simulate turns 1+2 in a SINGLE sandbox (matching engine flow: one sandbox per run) ---
    const sb = await PythonSandbox.spawn({
      depth: 1, execTimeoutS: 5,
      handlers: { llmQuery: async () => "stub", llmQueryBatched: async (ps) => ps.map(() => "stub") },
    });
    const rnonce = randomUUID();
    let r = await sb.exec("x = 42");
    check("turn 1: x assigned", !r.raised);

    const snap1 = snapshotPath(cwd, dir, runId, 1);
    check("turn 1: snapshot written", await sb.snapshot(snap1, rnonce));
    check("turn 1: pkl exists", existsSync(snap1));

    r = await sb.exec("y = 'hello'");
    check("turn 2: y assigned", !r.raised);

    const snap2 = snapshotPath(cwd, dir, runId, 2);
    check("turn 2: snapshot written", await sb.snapshot(snap2, rnonce));
    check("turn 2: pkl exists", existsSync(snap2));
    await sb.dispose();

    // --- Write the turn rows ---
    const t1: TurnRow = {
      kind: "turn", turn: 1, ts: new Date().toISOString(),
      response: "Let me compute x.", replOutputs: "[repl] x=42",
      error: false, usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 50 },
      cumulativeDurationMs: 1500, snapshotOk: true,
    };
    check("turn 1 row written", appendRow(cwd, dir, runId, t1));

    const t2: TurnRow = {
      kind: "turn", turn: 2, ts: new Date().toISOString(),
      response: "Now y.", replOutputs: "[repl] y=hello", answerContent: "partial",
      error: false, usage: { costUsd: 0.02, inputTokens: 200, outputTokens: 100 },
      cumulativeDurationMs: 3000, snapshotOk: true,
    };
    check("turn 2 row written", appendRow(cwd, dir, runId, t2));

    // --- Reconstruct state (simulates /rlm-resume) ---
    const systemPrompt = "You are a test RLM.";
    const recon = reconstructRlmState(cwd, dir, runId, systemPrompt);
    check("reconstruct ok", recon.ok);
    if (recon.ok) {
      check("completedTurns = 2", recon.completedTurns === 2, String(recon.completedTurns));
      check("snapshotTurn = 2 (latest pkl exists)", recon.snapshotTurn === 2, String(recon.snapshotTurn));
      check("usageSeed cost accumulated", Math.abs(recon.usageSeed.costUsd - 0.03) < 0.0001, String(recon.usageSeed.costUsd));
      check("usageSeed tokens accumulated", recon.usageSeed.inputTokens === 300 && recon.usageSeed.outputTokens === 150);
      check("usageSeed durationMs carried over", recon.usageSeed.durationMs === 3000, String(recon.usageSeed.durationMs));
      check("best from turn 2", recon.best === "partial");
      check("history rebuilt", recon.history.length >= 3);
      check("pendingReplOutputs from turn 2", recon.pendingReplOutputs === "[repl] y=hello");

      // --- Restore sandbox from the reconstructed snapshotTurn ---
      const sb3 = await PythonSandbox.spawn({
        depth: 1, execTimeoutS: 5,
        handlers: { llmQuery: async () => "stub", llmQueryBatched: async (ps) => ps.map(() => "stub") },
      });
      const restorePath = snapshotPath(cwd, dir, runId, recon.snapshotTurn!);
      check("sandbox restored from turn 2", await sb3.restore(restorePath, rnonce));
      r = await sb3.exec("print(x, y)");
      check("REPL vars survive: x=42 y=hello", r.stdout.trim() === "42 hello", r.stdout.trim());
      await sb3.dispose();

      // --- R-C1: fallback — delete turn 2 pkl, reconstruct should fall back to turn 1 ---
      unlinkSync(snap2);
      const recon2 = reconstructRlmState(cwd, dir, runId, systemPrompt);
      check("R-C1: fallback snapshotTurn = 1", recon2.ok && recon2.snapshotTurn === 1, recon2.ok ? String(recon2.snapshotTurn) : "not ok");
      if (recon2.ok && recon2.snapshotTurn !== undefined) {
        const sb4 = await PythonSandbox.spawn({
          depth: 1, execTimeoutS: 5,
          handlers: { llmQuery: async () => "stub", llmQueryBatched: async (ps) => ps.map(() => "stub") },
        });
        const fallbackPath = snapshotPath(cwd, dir, runId, recon2.snapshotTurn);
        check("R-C1: restore from turn 1 fallback", await sb4.restore(fallbackPath, rnonce));
        r = await sb4.exec("print(x)");
        check("R-C1: x=42 from turn 1", r.stdout.trim() === "42", r.stdout.trim());
        r = await sb4.exec("print(y)");
        check("R-C1: y NOT in turn 1 snapshot", r.raised, r.stdout.trim() + r.stderr.trim());
        await sb4.dispose();
      }

      // --- Pickle trust guard: restore with wrong nonce rejected ---
      const trustSnap = snapshotPath(cwd, dir, runId);
      const trustNonce = randomUUID();
      const sb5 = await PythonSandbox.spawn({
        depth: 1, execTimeoutS: 5,
        handlers: { llmQuery: async () => "stub", llmQueryBatched: async (ps) => ps.map(() => "stub") },
      });
      await sb5.exec("x = 99");
      check("trust guard: snapshot with nonce", await sb5.snapshot(trustSnap, trustNonce));
      const restoreWrongNonce = await sb5.restore(trustSnap, "wrong-nonce-12345");
      check("trust guard: restore with wrong nonce rejected", !restoreWrongNonce, "should have returned false");
      const restoreRightNonce = await sb5.restore(trustSnap, trustNonce);
      check("trust guard: restore with correct nonce accepted", restoreRightNonce, "should have returned true");
      if (restoreRightNonce) {
        r = await sb5.exec("print(x)");
        check("trust guard: x=99 restored via correct nonce", r.stdout.trim() === "99", r.stdout.trim());
      }
      await sb5.dispose();
    }

    // --- R-C2: missing context sidecar warning ---
    const runId2 = generateRunId();
    const header2: RunHeader = { ...header, runId: runId2 };
    appendRow(cwd, dir, runId2, header2);
    // No writeContextSidecar call — sidecar is missing
    const snapR2 = snapshotPath(cwd, dir, runId2, 1);
    const sb6 = await PythonSandbox.spawn({
      depth: 1, execTimeoutS: 5,
      handlers: { llmQuery: async () => "stub", llmQueryBatched: async (ps) => ps.map(() => "stub") },
    });
    await sb6.exec("z = 1");
    check("R-C2: snapshot written", await sb6.snapshot(snapR2, randomUUID()));
    await sb6.dispose();
    const t1r2: TurnRow = {
      kind: "turn", turn: 1, ts: new Date().toISOString(),
      response: "ok", error: false,
      usage: { costUsd: 0.01, inputTokens: 50, outputTokens: 25 },
      cumulativeDurationMs: 500, snapshotOk: true,
    };
    appendRow(cwd, dir, runId2, t1r2);
    const recon3 = reconstructRlmState(cwd, dir, runId2, systemPrompt);
    check("R-C2: reconstruct ok without sidecar", recon3.ok);
    // The caller (rlm.ts) would check readContextSidecar and warn — here we just verify it doesn't crash.
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
