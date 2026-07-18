/**
 * Fail-soft JSONL writes for the RLM run-state module.
 *
 * Every writer returns `boolean` and warns on failure — never throws into
 * the engine loop. A failed `appendRow` disables persistence for the rest
 * of the run without aborting the answer.
 */

import { appendFile, mkdir, open, rm, writeFile } from "node:fs/promises";
import { contextPath, runDir, runsDir, trailPath } from "./paths.ts";
import type { Row, TodoRow } from "./rows.ts";
import { errorMessage, failSoft, listDirectoriesSorted, warn } from "./internal.ts";

/** mkdir + append one JSON line. Returns true on success; warns + false on throw. Never throws. */
export async function appendRow(cwd: string, dir: string, runId: string, row: Row): Promise<boolean> {
  return await failSoft(async () => {
    await mkdir(runDir(cwd, dir, runId), { recursive: true });
    const path = trailPath(cwd, dir, runId);
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf-8");
    // QC: fsync to flush kernel buffers — crash between write and sync would lose the last row
    const file = await open(path, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  }, false);
}

export async function appendTodoRow(cwd: string, dir: string, runId: string, row: Omit<TodoRow, "kind">): Promise<boolean> {
  return await appendRow(cwd, dir, runId, { kind: "todo", ...row });
}

/** Persist a context payload for resume. Slot 0 = repo context; index ≥ 1 = load_library slots. */
export async function writeContextSidecar(
  cwd: string, dir: string, runId: string, context: unknown, json: boolean, index = 0,
): Promise<boolean> {
  return await failSoft(async () => {
    await mkdir(runDir(cwd, dir, runId), { recursive: true });
    await writeFile(contextPath(cwd, dir, runId, json, index), json ? JSON.stringify(context) : String(context), "utf-8");
    return true;
  }, false);
}

/** Prune oldest run directories beyond maxRuns. Best-effort; never throws. */
export async function pruneRuns(cwd: string, dir: string, maxRuns: number): Promise<void> {
  try {
    const ids = await listDirectoriesSorted(runsDir(cwd, dir)); // newest first (slug sorts chronologically)
    const pruned = ids.slice(maxRuns);
    if (pruned.length > 0) console.log(`[rlm-state] pruning ${pruned.length} runs (maxRuns=${maxRuns})`);
    for (const id of pruned) {
      await rm(runDir(cwd, dir, id), { recursive: true, force: true });
    }
  } catch (e) {
    warn(`pruneRuns failed: ${errorMessage(e)}`);
  }
}
