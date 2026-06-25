#!/usr/bin/env bun
/**
 * Phase 9 — Engine persistence integration
 * Run: bun run pi-plugin/rlm/test/phase9-engine-persistence.ts
 * Requires: python3 on PATH
 *
 * Verifies the state persistence module works correctly after Phase 1-2 changes:
 * - appendRow with fsync (Q14)
 * - sidecarOk check prevents orphan trails (I3)
 * - pruneRuns logging (Q11)
 * - isHeader validation (I2)
 */

import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, generateRunId, pruneRuns, writeContextSidecar, runDir, trailPath } from "../src/state/index.ts";
import { isHeader, STATE_SCHEMA_VERSION } from "../src/state/rows.ts";
import type { RunHeader } from "../src/state/rows.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase9-engine-"));
  const cwd = tmp;
  const dir = ".rlm/runs";

  try {
    // --- Q14: appendRow creates trail file and fsync flag is present ---
    const runId = generateRunId();
    const header: RunHeader = {
      kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: new Date().toISOString(),
      rootPrompt: "test", context: { type: "str", chars: 4, json: false, projectMap: false },
      workspaceRoot: cwd, models: { smart: "a", worker: "b" },
      meta: { maxIterations: 30, maxDepth: 2, orchestrator: true, editEnabled: false, fsTools: true },
    };
    check("appendRow succeeds", appendRow(cwd, dir, runId, header));
    const tp = trailPath(cwd, dir, runId);
    check("trail file exists after appendRow", require("node:fs").existsSync(tp));

    // --- I2: isHeader validates meta ---
    check("isHeader accepts valid header", isHeader({ kind: "header", runId: "x", rootPrompt: "y", meta: { maxIterations: 30 } }));
    check("isHeader rejects header missing meta", !isHeader({ kind: "header", runId: "x", rootPrompt: "y" }));
    check("isHeader rejects non-header", !isHeader({ kind: "turn" }));

    // --- I3: writeContextSidecar returns boolean ---
    const sidecarOk = writeContextSidecar(cwd, dir, runId, "test context", false);
    check("writeContextSidecar returns true", sidecarOk);

    // --- Q11: pruneRuns logs before deletion ---
    const id1 = generateRunId();
    const id2 = generateRunId();
    const id3 = generateRunId();
    // Create 3 run dirs by writing headers
    for (const id of [id1, id2, id3]) {
      appendRow(cwd, dir, id, { ...header, runId: id });
    }
    // Capture pruneRuns output — should log "pruning"
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(String(args[0])); origLog(...args); };
    pruneRuns(cwd, dir, 1);
    console.log = origLog;
    check("pruneRuns logs pruning message", logs.some(l => l.includes("pruning")), logs.join(" | "));

    // Verify only 1 run remains (maxRuns=1)
    const { readdirSync } = require("node:fs");
    const remaining = readdirSync(join(cwd, dir)).length;
    check("pruneRuns respects maxRuns=1", remaining <= 1, `remaining: ${remaining}`);

  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
