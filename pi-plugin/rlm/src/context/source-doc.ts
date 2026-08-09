/**
 * Document container → anydoc → Markdown → ContextFile, with on-disk MD cache.
 *
 * Stamp is captured BEFORE conversion so mid-edit races cannot freeze a stale body forever.
 * Document size is capped at MAX_DOCUMENT_BYTES (walk and single-file paths share this).
 */

import type { AnydocHandle } from "./anydoc.ts";
import { captureStamp, readMdCache, writeMdCache } from "./md-cache.ts";
import { makeContextFile } from "./merge.ts";
import { applyPathPrefix } from "./namespace.ts";
import {
  MAX_DOCUMENT_BYTES,
  type ContextFile,
  type SkipReason,
  type SkippedFile,
} from "./types.ts";

export type DocFileResult =
  | { readonly ok: true; readonly value: ContextFile; /** true only for a real anydoc conversion */ readonly converted: boolean }
  | { readonly ok: false; readonly skipped: SkippedFile };

function skipReasonFromError(err: unknown): SkipReason {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code: unknown = err.code;
    // Preserve anydoc ConvertErrorCode values rather than collapsing to "convert-failed".
    if (code === "unsupported" || code === "malformed" || code === "encrypted"
      || code === "resourceLimit" || code === "missingPart" || code === "io") {
      return code;
    }
  }
  return "convert-failed";
}

/**
 * Convert a document file to a ContextFile via anydoc.
 * Cache hits do not increment `converted`. Failures degrade to skipped, never throw.
 */
export async function documentToContextFile(
  absPath: string,
  relPath: string,
  pathPrefix: string,
  anydoc: AnydocHandle | null,
): Promise<DocFileResult> {
  const path = applyPathPrefix(relPath, pathPrefix);
  if (anydoc === null) {
    return { ok: false, skipped: Object.freeze({ path, reason: "no-converter" }) };
  }

  const stamp = await captureStamp(absPath);
  if (stamp === undefined) {
    return { ok: false, skipped: Object.freeze({ path, reason: "unreadable" }) };
  }
  if (stamp.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, skipped: Object.freeze({ path, reason: "oversized" }) };
  }

  try {
    const cached = await readMdCache(absPath);
    if (cached !== undefined) {
      // Cache hit — document is in context, but no conversion was performed.
      return { ok: true, value: makeContextFile(path, cached), converted: false };
    }
    const markdown = await anydoc.toMarkdown(absPath);
    // Pass the PRE-conversion stamp — never re-stat after convert (stale-forever bug).
    await writeMdCache(absPath, markdown, stamp);
    return { ok: true, value: makeContextFile(path, markdown), converted: true };
  } catch (err: unknown) {
    return { ok: false, skipped: Object.freeze({ path, reason: skipReasonFromError(err) }) };
  }
}
