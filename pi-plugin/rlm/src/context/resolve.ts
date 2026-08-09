/**
 * One router: source string → SourceResult.
 * git URL → source-git · dir → source-dir · file → document? source-doc : source-text.
 */

import { basename, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { Result } from "../util/errors.ts";
import { documentExtFromPath, getAnydoc } from "./anydoc.ts";
import { GIT_URL, contextSourceId, pathPrefixFor } from "./namespace.ts";
import { documentToContextFile } from "./source-doc.ts";
import { sourceDir } from "./source-dir.ts";
import { sourceGit } from "./source-git.ts";
import { textToContextFile } from "./source-text.ts";
import { checkPathSafety, isSensitivePath } from "./walk.ts";
import {
  MAX_CONTEXT_FILE_BYTES,
  type ResolveOpts,
  type SourceResult,
} from "./types.ts";

function emptySkipped(): SourceResult["skipped"] {
  return Object.freeze([]);
}

function singleFileResult(
  file: SourceResult["payload"][number],
  sourceId: string,
  pathPrefix: string,
  documents: number,
  converted: number,
  skipped: SourceResult["skipped"] = emptySkipped(),
): SourceResult {
  return Object.freeze({
    payload: Object.freeze([file]),
    files: 1,
    chars: file.content.length,
    sourceId,
    pathPrefix,
    documents,
    converted,
    skipped,
  });
}

/**
 * Resolve a source string (local path or git URL) into a sandbox-ready SourceResult.
 * `pathPrefix: ""` marks the primary/cwd source (un-prefixed paths).
 */
export async function resolveSource(
  source: string,
  opts: ResolveOpts,
): Promise<Result<SourceResult, string>> {
  const trimmed = source.trim();
  if (trimmed === "") return { ok: false, error: "add_context: empty source" };
  if (GIT_URL.test(trimmed)) return await sourceGit(trimmed, opts);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, error: `unsupported URL scheme (only https:// and git@ are allowed): ${trimmed}` };
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(opts.cwd, trimmed);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch {
    return { ok: false, error: `add_context: path not found: ${path}` };
  }
  const sourceId = contextSourceId(trimmed, path);
  const pathPrefix = opts.pathPrefix !== undefined ? opts.pathPrefix : pathPrefixFor(sourceId);

  if (s.isDirectory()) {
    return { ok: true, value: await sourceDir(path, trimmed, { ...opts, pathPrefix }) };
  }

  // Single-file secret refuse — never pack a .env / key into context for a sub-LLM.
  const rel = basename(path);
  if (isSensitivePath(rel) || isSensitivePath(trimmed.replace(/^\.\//, ""))) {
    return { ok: false, error: `add_context: refused sensitive path: ${path}` };
  }

  // Symlink safety for single-file: refuse escape of cwd / resolved sensitive targets.
  const safety = await checkPathSafety(path, opts.cwd);
  if (!safety.ok) {
    return {
      ok: false,
      error: `add_context: refused ${safety.reason} path: ${path}`,
    };
  }

  // Single file — preserve oversize wording (phase-context asserts on limit + llm_query_chunked).
  if (s.size > MAX_CONTEXT_FILE_BYTES) {
    return {
      ok: false,
      error: `add_context: ${path} is ${s.size.toLocaleString()} bytes `
        + `(limit ${MAX_CONTEXT_FILE_BYTES.toLocaleString()}) — `
        + "open() it in the REPL and delegate with llm_query_chunked instead",
    };
  }

  const anydoc = await getAnydoc();
  // formatFromPath is extension-based; one call on the path is enough.
  const format = anydoc?.formatFromPath(path) ?? documentExtFromPath(path);
  if (format !== null) {
    const doc = await documentToContextFile(safety.realAbs, rel, pathPrefix, anydoc);
    if (!doc.ok) {
      return { ok: false, error: `add_context: could not convert ${path} (${doc.skipped.reason})` };
    }
    return {
      ok: true,
      value: singleFileResult(
        doc.value, sourceId, pathPrefix,
        1, // documents
        doc.converted ? 1 : 0,
      ),
    };
  }

  const text = await textToContextFile(safety.realAbs, rel, pathPrefix, MAX_CONTEXT_FILE_BYTES);
  if (!text.ok) {
    return { ok: false, error: `add_context: could not read ${path} (${text.skipped.reason})` };
  }
  return { ok: true, value: singleFileResult(text.value, sourceId, pathPrefix, 0, 0) };
}
