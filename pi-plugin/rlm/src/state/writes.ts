/**
 * Fail-soft JSONL writes for the RLM run-state module.
 *
 * Every writer returns `boolean` and warns on failure — never throws into
 * the engine loop. A failed `appendRow` disables persistence for the rest
 * of the run without aborting the answer.
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { contextPath, runDir, runsDir, trailPath } from "./paths.ts";
import type { Row } from "./rows.ts";
import { warn } from "./internal.ts";

/** mkdir + append one JSON line. Returns true on success; warns + false on throw. Never throws. */
export function appendRow(cwd: string, dir: string, runId: string, row: Row): boolean {
  try {
    mkdirSync(runDir(cwd, dir, runId), { recursive: true });
    const path = trailPath(cwd, dir, runId);
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf-8");
    // QC: fsync to flush kernel buffers — crash between write and sync would lose the last row
    const fd = openSync(path, "r+");
    fsyncSync(fd);
    closeSync(fd);
    return true;
  } catch (e) {
    warn(e);
    return false;
  }
}

/** Persist the original context ONCE at run start so resume can reload it. */
export function writeContextSidecar(cwd: string, dir: string, runId: string, context: unknown, json: boolean): boolean {
  try {
    mkdirSync(runDir(cwd, dir, runId), { recursive: true });
    writeFileSync(contextPath(cwd, dir, runId, json), json ? JSON.stringify(context) : String(context), "utf-8");
    return true;
  } catch (e) {
    warn(e);
    return false;
  }
}

/** Prune oldest run directories beyond maxRuns. Best-effort; never throws. */
export function pruneRuns(cwd: string, dir: string, maxRuns: number): void {
  try {
    const root = runsDir(cwd, dir);
    const ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse(); // newest first (slug sorts chronologically)
    const pruned = ids.slice(maxRuns);
    if (pruned.length > 0) console.log(`[rlm-state] pruning ${pruned.length} runs (maxRuns=${maxRuns})`);
    for (const id of pruned) {
      rmSync(runDir(cwd, dir, id), { recursive: true, force: true });
    }
  } catch (e) {
    warn(`pruneRuns failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
