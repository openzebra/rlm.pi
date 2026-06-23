/**
 * Fail-soft JSONL readers for the RLM run-state module.
 *
 * `readRows` parses each line in its own try/catch so a truncated trailing
 * line cannot erase prior rows. `listRunIds` sorts directories newest-first
 * by the slug (ISO-like timestamps are self-sorting).
 */

import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { runsDir, trailPath, contextPath } from "./paths.ts";
import { isHeader, type RunHeader, type Row } from "./rows.ts";
import { errorMessage, warn } from "./internal.ts";

/** Every well-formed row, in trail order. Malformed line → one warn, skipped. */
export function readRows(cwd: string, dir: string, runId: string): Row[] {
  let lines: string[];
  try {
    const p = trailPath(cwd, dir, runId);
    if (!existsSync(p)) return [];
    const content = readFileSync(p, "utf-8").trim();
    if (!content) return [];
    lines = content.split("\n");
  } catch (e) {
    warn(e);
    return [];
  }
  const rows: Row[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as Row);
    } catch (e) {
      warn(`skipping malformed JSONL row — ${errorMessage(e)}`);
    }
  }
  return rows;
}

/** Read the first line of a trail file without reading the entire file (P1). */
function readFirstLine(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    const size = Math.min(statSync(path).size, 65536);
    const buf = Buffer.alloc(size);
    const bytesRead = readSync(fd, buf, 0, size, 0);
    closeSync(fd);
    const content = buf.toString("utf-8", 0, bytesRead);
    const nl = content.indexOf("\n");
    return nl >= 0 ? content.slice(0, nl) : content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** First well-formed header row, or undefined. Bounded read — never reads the full trail (P1). */
export function readHeader(cwd: string, dir: string, runId: string): RunHeader | undefined {
  const line = readFirstLine(trailPath(cwd, dir, runId));
  if (!line) return undefined;
  try {
    const row = JSON.parse(line) as unknown;
    return isHeader(row) ? row : undefined;
  } catch {
    return undefined;
  }
}

/** Reload context from a persistent sidecar file. */
export function readContextSidecar(cwd: string, dir: string, runId: string, json: boolean): unknown {
  try {
    const p = contextPath(cwd, dir, runId, json);
    if (!existsSync(p)) return undefined;
    const content = readFileSync(p, "utf-8");
    return json ? JSON.parse(content) : content;
  } catch (e) {
    warn(e);
    return undefined;
  }
}

/** Enumerate run-ids by directory listing; newest first (slug sorts chronologically). */
export function listRunIds(cwd: string, dir: string): string[] {
  try {
    return readdirSync(runsDir(cwd, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** `@latest` / explicit id resolution. */
export function resolveRunId(cwd: string, dir: string, ref: string): string | undefined {
  if (ref === "@latest") return listRunIds(cwd, dir)[0];
  return listRunIds(cwd, dir).includes(ref) ? ref : undefined;
}
