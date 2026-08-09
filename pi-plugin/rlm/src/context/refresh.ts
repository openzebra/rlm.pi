/**
 * Keep RLM `context` in sync with the disk after native edit/write.
 *
 * Seed packs file bodies once; without this, search/map_files/llm still see pre-edit text.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { estimateTokens } from "../text/tokens.ts";
import type { ContextFile } from "./types.ts";

/** Paths that look like tool file targets. */
export function extractEditPaths(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return Object.freeze([]);
  const o = input as Record<string, unknown>;
  const keys = ["path", "file_path", "filePath", "filename", "file"] as const;
  const out: string[] = [];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
  // Some tools pass { path, oldText, newText } only — already covered.
  return Object.freeze(out);
}

/**
 * Normalize disk path to how cwd-seed entries usually appear (relative to cwd when under cwd).
 */
export function normalizeContextPath(filePath: string, cwd: string): string {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split("\\").join("/");
}

function pathMatches(entryPath: string, target: string, cwd: string): boolean {
  if (entryPath === target) return true;
  const a = normalizeContextPath(entryPath, cwd);
  const b = normalizeContextPath(target, cwd);
  if (a === b) return true;
  // suffix match for namespaced entries
  return entryPath.endsWith("/" + target) || entryPath.endsWith(target);
}

/**
 * Upsert one file into a context payload list. Returns a **new** array (identity change
 * so BM25 stamp invalidates when the worker rebinds `context`).
 */
export function upsertContextFile(
  payload: unknown,
  filePath: string,
  content: string,
  cwd: string,
): ContextFile[] {
  const path = normalizeContextPath(filePath, cwd);
  const tokens = estimateTokens(content.length);
  const entry: ContextFile = Object.freeze({ path, content, tokens });

  if (!Array.isArray(payload)) {
    return [entry];
  }

  const next = new Array<ContextFile>(payload.length + 1);
  let n = 0;
  let replaced = false;
  for (let i = 0; i < payload.length; i++) {
    const item: unknown = payload[i];
    if (
      item !== null &&
      typeof item === "object" &&
      "path" in item &&
      typeof (item as { path: unknown }).path === "string" &&
      pathMatches((item as { path: string }).path, path, cwd)
    ) {
      next[n++] = entry;
      replaced = true;
    } else if (
      item !== null &&
      typeof item === "object" &&
      "path" in item &&
      "content" in item &&
      typeof (item as { path: unknown }).path === "string" &&
      typeof (item as { content: unknown }).content === "string"
    ) {
      const e = item as { path: string; content: string; tokens?: number };
      next[n++] = Object.freeze({
        path: e.path,
        content: e.content,
        tokens: typeof e.tokens === "number" ? e.tokens : estimateTokens(e.content.length),
      });
    }
    // drop non-file entries silently (shouldn't appear in file bundles)
  }
  if (!replaced) next[n++] = entry;
  next.length = n;
  return next;
}

/** Read file from disk; return null if missing/unreadable. */
export async function readDiskFile(filePath: string, cwd: string): Promise<string | null> {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Python snippet that rebinds `context` with updated path content and forces a new list id
 * so BM25 rebuilds on next search.
 */
export function patchContextExecCode(filePath: string, content: string, cwd: string): string {
  const path = normalizeContextPath(filePath, cwd);
  // JSON for safe embedding in Python string literals
  const pathLit = JSON.stringify(path);
  const contentLit = JSON.stringify(content);
  const tokens = estimateTokens(content.length);
  return `
_path = ${pathLit}
_content = ${contentLit}
_tokens = ${tokens}
_old = context if isinstance(context, list) else []
_next = []
_found = False
for _e in _old:
    if isinstance(_e, dict) and str(_e.get("path", "")) in (_path, _path.replace("\\\\", "/")):
        _next.append({"path": _path, "content": _content, "tokens": _tokens})
        _found = True
    elif isinstance(_e, dict) and (
        str(_e.get("path", "")).endswith("/" + _path) or str(_e.get("path", "")).endswith(_path)
    ):
        _next.append({"path": str(_e.get("path")), "content": _content, "tokens": _tokens})
        _found = True
    else:
        _next.append(_e)
if not _found:
    _next.append({"path": _path, "content": _content, "tokens": _tokens})
context = _next
`.trim();
}
