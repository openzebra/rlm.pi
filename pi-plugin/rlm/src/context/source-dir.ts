/**
 * Directory pack: walk + per-file routing (bounded pool).
 *
 * Routing order is load-bearing:
 *   sensitive (link name)?  → skipped: "sensitive"
 *   checkPathSafety (lstat/realpath; escape / resolved-sensitive)
 *   format != null          → documentToContextFile() ← MUST come before isBinary
 *   else                    → textToContextFile()
 *
 * A .docx IS binary. Reversed, every document in the tree would be dropped as an asset —
 * precisely the bug this change exists to fix.
 */

import { join } from "node:path";
import { documentExtFromPath, getAnydoc, type AnydocHandle } from "./anydoc.ts";
import { Semaphore } from "../util/concurrency.ts";
import { documentToContextFile } from "./source-doc.ts";
import { textToContextFile } from "./source-text.ts";
import { checkPathSafety, enumerateFiles, isSensitivePath } from "./walk.ts";
import {
  MAX_SKIPPED_REPORTED,
  type ContextFile,
  type ResolveOpts,
  type SkippedFile,
  type SourceResult,
} from "./types.ts";
import { applyPathPrefix, contextSourceId, pathPrefixFor } from "./namespace.ts";

/** Conversions are libuv-threadpool bound (default pool 4); 8 keeps the pool busy without thrash. */
const CONVERT_CONCURRENCY = 8;

export interface PackDirResult {
  readonly files: readonly ContextFile[];
  readonly chars: number;
  readonly documents: number;
  readonly converted: number;
  readonly skipped: readonly SkippedFile[];
}

/**
 * Walk `dir` and produce ContextFiles. Resolves the anydoc handle once per source
 * (not per file) and threads it into the per-file router.
 */
export async function packDirectory(
  dir: string,
  pathPrefix: string,
  signal?: AbortSignal,
  anydoc?: AnydocHandle | null,
): Promise<PackDirResult> {
  const paths = await enumerateFiles(dir, signal);
  if (paths.length === 0) {
    return Object.freeze({
      files: Object.freeze([]),
      chars: 0,
      documents: 0,
      converted: 0,
      skipped: Object.freeze([]),
    });
  }

  // One handle check per source, not per file.
  const handle = anydoc !== undefined ? anydoc : await getAnydoc();
  const gate = new Semaphore(CONVERT_CONCURRENCY);
  // Pre-allocated slots; compacted in one pass with a single length trim — house style.
  const slots = new Array<ContextFile | undefined>(paths.length);
  const drops = new Array<SkippedFile | undefined>(paths.length);
  const didConvert = new Array<boolean>(paths.length); // true = fresh anydoc conversion
  const isDoc = new Array<boolean>(paths.length); // true = document-type entry in payload

  await Promise.all(paths.map((rel, i) => gate.run(async () => {
    if (signal?.aborted) {
      drops[i] = Object.freeze({ path: applyPathPrefix(rel, pathPrefix), reason: "aborted" });
      return;
    }
    // Sensitive deny-list on the enumerated name — second net under .gitignore.
    if (isSensitivePath(rel)) {
      drops[i] = Object.freeze({ path: applyPathPrefix(rel, pathPrefix), reason: "sensitive" });
      return;
    }
    const abs = join(dir, rel);
    // Symlink safety: realpath, refuse escape of pack root, re-check sensitive on target.
    const safety = await checkPathSafety(abs, dir);
    if (!safety.ok) {
      drops[i] = Object.freeze({ path: applyPathPrefix(rel, pathPrefix), reason: safety.reason });
      return;
    }
    const readAbs = safety.realAbs;
    // Document router FIRST — a .docx is binary and would be dropped by the text path.
    // When anydoc is absent, still detect by extension so documents skip as "no-converter".
    const format = handle?.formatFromPath(rel) ?? documentExtFromPath(rel);
    if (format !== null) {
      const doc = await documentToContextFile(readAbs, rel, pathPrefix, handle);
      if (doc.ok) {
        slots[i] = doc.value;
        didConvert[i] = doc.converted;
        isDoc[i] = true;
      } else {
        drops[i] = doc.skipped;
      }
      return;
    }
    const text = await textToContextFile(readAbs, rel, pathPrefix);
    if (text.ok) {
      slots[i] = text.value;
      didConvert[i] = false;
      isDoc[i] = false;
    } else {
      drops[i] = text.skipped;
    }
  })));

  const files = new Array<ContextFile>(paths.length);
  const skipped = new Array<SkippedFile>(paths.length);
  let nFiles = 0;
  let nSkip = 0;
  let chars = 0;
  let converted = 0;
  let documents = 0;
  for (let i = 0; i < paths.length; i++) {
    const f = slots[i];
    if (f !== undefined) {
      files[nFiles++] = f;
      chars += f.content.length;
      if (didConvert[i]) converted += 1;
      if (isDoc[i]) documents += 1;
      continue;
    }
    const d = drops[i];
    // Filter unreadable from the model-facing skip list (ENOENT on deleted-tracked paths).
    // Cap so an asset-heavy repo cannot flood the wire / reply frame.
    if (d !== undefined && d.reason !== "unreadable" && nSkip < MAX_SKIPPED_REPORTED) {
      skipped[nSkip++] = d;
    }
  }
  files.length = nFiles;
  skipped.length = nSkip;
  return Object.freeze({
    files: Object.freeze(files),
    chars,
    documents,
    converted,
    skipped: Object.freeze(skipped),
  });
}

/** Pack a directory into a SourceResult with derived (or explicit) namespace. */
export async function sourceDir(
  dir: string,
  source: string,
  opts: ResolveOpts,
): Promise<SourceResult> {
  const sourceId = contextSourceId(source, dir);
  // Explicit pathPrefix (including "") wins; otherwise derive ctx/<id>/.
  const pathPrefix = opts.pathPrefix !== undefined ? opts.pathPrefix : pathPrefixFor(sourceId);
  const packed = await packDirectory(dir, pathPrefix, opts.signal);
  return Object.freeze({
    payload: packed.files,
    files: packed.files.length,
    chars: packed.chars,
    sourceId,
    pathPrefix,
    documents: packed.documents,
    converted: packed.converted,
    skipped: packed.skipped,
  });
}
