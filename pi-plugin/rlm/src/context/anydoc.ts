/**
 * Lazy NAPI handle for @firecrawl/anydoc.
 *
 * anydoc is a native addon with per-platform optionalDependencies (darwin x64/arm64,
 * linux x64/arm64 gnu+musl, win32 x64 — NO win32-arm64). A static `import` on an uncovered
 * platform is a plugin-load crash. So: import() once, memoised, catch → null. Absence is a
 * value; documents degrade to skipped: "no-converter".
 */

/** Minimal surface we consume — never re-export the full anydoc package. */
export interface AnydocHandle {
  /** Detect document format from a path's extension; null for plain text / unknown. */
  readonly formatFromPath: (path: string) => string | null;
  /** Convert a document file to Markdown. Rejects with Error.code = ConvertErrorCode. */
  readonly toMarkdown: (path: string) => Promise<string>;
}

/**
 * Document container extensions anydoc knows about, including Office macro/variants.
 * Used when the native addon is absent so we still route these to "no-converter"
 * instead of reading them as broken binary text.
 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = Object.freeze(new Set([
  "doc", "docx", "docm", "odt", "rtf", "epub", "pdf",
  "ppt", "pptx", "pptm", "ppsx", "odp",
  "xls", "xlsx", "xlsm", "xlsb", "ods", "csv",
]));

/**
 * Detect a document container from a path when the anydoc handle is unavailable.
 * Returns a non-null token for known extensions so the router can skip as "no-converter".
 */
export function documentExtFromPath(path: string): string | null {
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
}

let cached: Promise<AnydocHandle | null> | undefined;

/**
 * Resolve the anydoc handle once per process. Returns null when the native addon is
 * missing or fails to load — callers treat documents as skipped: "no-converter".
 */
export function getAnydoc(): Promise<AnydocHandle | null> {
  cached ??= import("@firecrawl/anydoc")
    .then((mod): AnydocHandle => Object.freeze({
      formatFromPath: (p: string) => mod.formatFromPath(p),
      toMarkdown: (p: string) => mod.toMarkdown(p),
    }))
    .catch(() => null);
  return cached;
}

/**
 * Test seam: force the next getAnydoc() call to return a fixed handle (or null).
 * Pass `undefined` to restore the real lazy loader.
 */
export function setAnydocForTest(handle: AnydocHandle | null | undefined): void {
  if (handle === undefined) {
    cached = undefined;
    return;
  }
  cached = Promise.resolve(handle);
}
