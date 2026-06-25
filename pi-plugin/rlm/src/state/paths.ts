/**
 * Pure path/id helpers for the RLM run-state module.
 *
 * Run-IDs are filename-sortable ISO-like slugs with a random hex suffix
 * for sub-second collision safety. All helpers are pure — no I/O.
 */

import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

const RUN_ID_SUFFIX_BYTES = 2;
const ISO_DATETIME_LENGTH = 19;

/** `YYYY-MM-DD_HH-MM-SS-<4hex>` — filename-sortable, sub-second collision-safe.
 *
 * Prune ordering in writes.ts:pruneRuns depends on the ISO-slug format producing
 * chronologically sortable strings. If the format changes, update pruning logic
 * to maintain oldest-first deletion. */
export function generateRunId(
  now: Date = new Date(),
  suffix: string = randomBytes(RUN_ID_SUFFIX_BYTES).toString("hex"),
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${iso.slice(0, ISO_DATETIME_LENGTH).replaceAll(":", "-").replace("T", "_")}-${suffix}`;
}

export const runsDir = (cwd: string, dir: string): string =>
  isAbsolute(dir) ? dir : join(cwd, dir);

export const runDir = (cwd: string, dir: string, runId: string): string => join(runsDir(cwd, dir), runId);

export const trailPath = (cwd: string, dir: string, runId: string): string => join(runDir(cwd, dir, runId), "trail.jsonl");

export const contextPath = (cwd: string, dir: string, runId: string, json: boolean): string =>
  join(runDir(cwd, dir, runId), json ? "context.json" : "context.txt");

/** R-C1: per-turn snapshot files — `sandbox-<turn>.pkl` so resume can fall back to a prior turn if the latest rename failed. */
export function snapshotPath(cwd: string, dir: string, runId: string, turn?: number): string {
  const name = turn !== undefined ? `sandbox-${turn}.pkl` : "sandbox.pkl";
  return join(runDir(cwd, dir, runId), name);
}
