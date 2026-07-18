/**
 * Fail-soft JSONL readers for the RLM run-state module.
 *
 * `readRows` parses each line in its own try/catch so a truncated trailing
 * line cannot erase prior rows. `listRunIds` sorts directories newest-first
 * by the slug (ISO-like timestamps are self-sorting).
 */

import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runsDir, runDir, trailPath, contextPath } from "./paths.ts";
import { isHeader, isRow, type RunHeader, type Row } from "./rows.ts";
import { errorMessage, failSoft, listDirectoriesSorted, pathExists, warn } from "./internal.ts";

/** Every well-formed row, in trail order. Malformed line → one warn, skipped. */
export async function readRows(cwd: string, dir: string, runId: string): Promise<Row[]> {
  const path = trailPath(cwd, dir, runId);
  if (!await pathExists(path)) return [];
  const content = await failSoft(
    () => readFile(path, "utf-8"),
    undefined as string | undefined,
  );
  const trimmed = content?.trim();
  if (!trimmed) return [];

  const rows: Row[] = [];
  for (const line of trimmed.split("\n")) {
    try {
      const row = JSON.parse(line) as unknown;
      if (isRow(row)) rows.push(row);
      else warn("skipping invalid JSONL row shape");
    } catch (e) {
      warn(`skipping malformed JSONL row — ${errorMessage(e)}`);
    }
  }
  return rows;
}

/** Read the first line of a trail file without reading the entire file (P1). */
async function readFirstLine(path: string): Promise<string | undefined> {
  return await failSoft(async () => {
    const file = await open(path, "r");
    try {
      const stats = await file.stat();
      const size = Math.min(stats.size, 65536);
      if (size <= 0) return undefined;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      const content = buffer.toString("utf-8", 0, bytesRead);
      const nl = content.indexOf("\n");
      return nl >= 0 ? content.slice(0, nl) : content.trim() || undefined;
    } finally {
      await file.close();
    }
  }, undefined as string | undefined, { warn: false });
}

/** First well-formed header row, or undefined. Bounded read — never reads the full trail (P1). */
export async function readHeader(cwd: string, dir: string, runId: string): Promise<RunHeader | undefined> {
  const line = await readFirstLine(trailPath(cwd, dir, runId));
  if (!line) return undefined;
  try {
    const row = JSON.parse(line) as unknown;
    return isHeader(row) ? row : undefined;
  } catch {
    return undefined;
  }
}

/** Reload context from a persistent sidecar file. */
export async function readContextSidecar(cwd: string, dir: string, runId: string, json: boolean): Promise<unknown> {
  const path = contextPath(cwd, dir, runId, json);
  if (!await pathExists(path)) return undefined;
  const content = await failSoft(
    () => readFile(path, "utf-8"),
    undefined as string | undefined,
  );
  if (content === undefined) return undefined;
  try {
    return json ? JSON.parse(content) as unknown : content;
  } catch (e) {
    warn(e);
    return undefined;
  }
}

const LIBRARY_SIDECAR = /^context\.(\d+)\.(json|txt)$/;

export interface LibrarySlot {
  readonly index: number;
  readonly payload: unknown;
}

/** Fail-soft lister for load_library resume sidecars (`context.<index>.json|txt`). */
export async function readLibrarySidecars(cwd: string, dir: string, runId: string): Promise<LibrarySlot[]> {
  const entries = await failSoft(() => readdir(runDir(cwd, dir, runId)), [] as string[]);
  const slots: LibrarySlot[] = [];
  for (const name of entries) {
    const m = LIBRARY_SIDECAR.exec(name);
    if (!m) continue;
    const index = Number(m[1]);
    const json = m[2] === "json";
    const content = await failSoft(
      () => readFile(join(runDir(cwd, dir, runId), name), "utf-8"),
      undefined as string | undefined,
    );
    if (content === undefined) continue;
    try {
      slots.push({ index, payload: json ? JSON.parse(content) as unknown : content });
    } catch (e) { warn(e); }
  }
  return slots.sort((a, b) => a.index - b.index);
}

/** Enumerate run-ids by directory listing; newest first (slug sorts chronologically). */
export async function listRunIds(cwd: string, dir: string): Promise<string[]> {
  return await failSoft(() => listDirectoriesSorted(runsDir(cwd, dir)), [], { warn: false });
}

/** `@latest` / explicit id resolution. */
export async function resolveRunId(cwd: string, dir: string, ref: string): Promise<string | undefined> {
  const ids = await listRunIds(cwd, dir);
  if (ref === "@latest") return ids[0];
  return ids.includes(ref) ? ref : undefined;
}
