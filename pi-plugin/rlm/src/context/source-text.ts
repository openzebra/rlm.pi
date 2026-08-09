/**
 * Plain (non-document) file → ContextFile.
 * The isBinary probe lives HERE — documents are routed earlier by formatFromPath.
 */

import { readFile, stat } from "node:fs/promises";
import { makeContextFile } from "./merge.ts";
import { applyPathPrefix } from "./namespace.ts";
import { isBinary } from "./walk.ts";
import { MAX_WALK_FILE_BYTES, type ContextFile, type SkippedFile } from "./types.ts";

export type TextFileResult =
  | { readonly ok: true; readonly value: ContextFile }
  | { readonly ok: false; readonly skipped: SkippedFile };

/**
 * Read a plain-text file into a ContextFile.
 * Skips binaries (NUL probe), oversize files, and unreadable paths.
 */
export async function textToContextFile(
  absPath: string,
  relPath: string,
  pathPrefix: string,
  maxBytes: number = MAX_WALK_FILE_BYTES,
): Promise<TextFileResult> {
  const path = applyPathPrefix(relPath, pathPrefix);
  try {
    const s = await stat(absPath);
    if (!s.isFile()) {
      return { ok: false, skipped: Object.freeze({ path, reason: "unreadable" }) };
    }
    if (s.size > maxBytes) {
      return { ok: false, skipped: Object.freeze({ path, reason: "oversized" }) };
    }
    // Binary probe AFTER the document router has already claimed known containers —
    // a .docx IS binary; routing order in source-dir is load-bearing.
    if (await isBinary(absPath)) {
      return { ok: false, skipped: Object.freeze({ path, reason: "binary" }) };
    }
    const content = await readFile(absPath, "utf-8");
    return { ok: true, value: makeContextFile(path, content) };
  } catch {
    return { ok: false, skipped: Object.freeze({ path, reason: "unreadable" }) };
  }
}
