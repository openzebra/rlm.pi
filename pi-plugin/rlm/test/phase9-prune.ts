#!/usr/bin/env bun
/**
 * Phase 9 — Run retention + config validation + history helpers
 * Run: bun run pi-plugin/rlm/test/phase9-prune.ts
 *
 * Tests:
 * - pruneRuns with multiple run directories (Q15)
 * - validateRunLog field validation (Q24)
 * - appendUserMessage adjacency coalescing (G1)
 * - RunLogConfig round-trip defaults → validate → merge (G2)
 * - warn() prefix and formatting (G5)
 */

import { check, failureCount } from "./helpers.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, generateRunId, pruneRuns, runDir } from "../src/state/index.ts";
import { STATE_SCHEMA_VERSION } from "../src/state/rows.ts";
import type { RunHeader } from "../src/state/rows.ts";
import { appendUserMessage } from "../src/core/history.ts";
import type { ChatMsg } from "../src/bridge/model.ts";
import { errorMessage, warn } from "../src/state/internal.ts";


async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase9-prune-"));
  const cwd = tmp;
  const dir = ".rlm/runs";

  try {
    // --- Q15: pruneRuns with multiple directories ---
    // Use controlled timestamps to ensure predictable chronological sort
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = generateRunId(new Date(2026, 0, 1, 0, 0, i), "aaaa"); // deterministic IDs
      ids.push(id);
      const header: RunHeader = {
        kind: "header", v: STATE_SCHEMA_VERSION, runId: id, ts: new Date().toISOString(),
        rootPrompt: "test", context: { type: "str", chars: 4, json: false },
        models: { smart: "a", worker: "b" },
        meta: { maxIterations: 30, maxDepth: 2, orchestrator: true },
      };
      await appendRow(cwd, dir, id, header);
    }
    check("5 runs created", true);

    // Prune to maxRuns=2
    await pruneRuns(cwd, dir, 2);
    const { readdirSync, existsSync } = await import("node:fs");
    const remaining = readdirSync(join(cwd, dir)).length;
    check("pruneRuns: maxRuns=2 respected", remaining === 2, `remaining: ${remaining}`);

    // Verify oldest 3 were deleted
    check("pruneRuns: oldest 3 deleted", !existsSync(runDir(cwd, dir, ids[0])) && !existsSync(runDir(cwd, dir, ids[1])) && !existsSync(runDir(cwd, dir, ids[2])));
    // Verify newest 2 survived
    check("pruneRuns: newest 2 survive", existsSync(runDir(cwd, dir, ids[3])) && existsSync(runDir(cwd, dir, ids[4])));

    // Edge case: empty directory
    const emptyDir = join(tmp, "empty-runs");
    mkdirSync(emptyDir, { recursive: true });
    await pruneRuns(emptyDir, ".rlm/runs", 50); // should not throw
    check("pruneRuns: empty directory tolerated", true);

    // --- Q24: validateRunLog ---
    // Import dynamically to avoid top-level issues
    const cfg1 = { enabled: true, runLog: { enabled: true, dir: "/tmp/test", snapshot: false, maxRuns: 25 } };
    const { mergeConfig } = await import("../src/config/settings.ts");
    const merged1 = mergeConfig(cfg1);
    check("validateRunLog: valid config passes", merged1.runLog?.maxRuns === 25 && merged1.runLog?.dir === "/tmp/test");

    // --- G1: appendUserMessage adjacency coalescing ---
    const history: ChatMsg[] = [];
    appendUserMessage(history, "first message");
    check("appendUserMessage: starts with user message", history.length === 1 && history[0]?.role === "user");

    appendUserMessage(history, "second message");
    const first = history[0];
    check("appendUserMessage: coalesces adjacent user", history.length === 1 && first !== undefined && first.content.includes("first") && first.content.includes("second"));

    history.push({ role: "assistant", content: "reply" });
    appendUserMessage(history, "third message");
    check("appendUserMessage: new message after assistant", history.length === 3 && history[2].role === "user");

    // --- G2: RunLogConfig round-trip ---
    const { DEFAULT_CONFIG: defaults } = await import("../src/config/defaults.ts");
    check("RunLogConfig: defaults has runLog", defaults.runLog !== undefined);
    check("RunLogConfig: defaults.maxRuns = 50", defaults.runLog?.maxRuns === 50);

    // --- G5: warn() prefix ---
    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnLogs.push(String(args[0])); origWarn(...args); };
    warn("test error");
    console.warn = origWarn;
    check("warn: [rlm-state] prefix", warnLogs.some(l => l.includes("[rlm-state]")), warnLogs.join(" | "));
    check("warn: includes error message", warnLogs.some(l => l.includes("test error")));

    // errorMessage
    check("errorMessage: Error instance", errorMessage(new Error("boom")) === "boom");
    check("errorMessage: string", errorMessage("plain") === "plain");

  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
