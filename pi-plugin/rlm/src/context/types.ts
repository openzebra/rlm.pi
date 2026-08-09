/**
 * Shared DTOs for every context producer (text, document, directory, git).
 * All producers return the same shape; nothing over ~150 lines per file.
 */

/** One file entry in the sandbox `context` list. */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly tokens: number;
}

/**
 * Why a path was not converted into a ContextFile.
 * Closed union — never a bare string (keeps skip reasons type-safe and visible).
 */
export type SkipReason =
  | "binary"
  | "sensitive"
  | "oversized"
  | "unreadable"
  | "no-converter"
  | "aborted"
  /** Symlink whose realpath escapes the packed root (deny-list bypass). */
  | "symlink-escape"
  /** anydoc ConvertErrorCode values, preserved rather than collapsed. */
  | "unsupported"
  | "malformed"
  | "encrypted"
  | "resourceLimit"
  | "missingPart"
  | "io"
  /** Fallback when an anydoc rejection carries no recognised code. */
  | "convert-failed";

/** A path that was enumerated but not converted into a ContextFile. */
export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
}

/**
 * Result of resolving one source (dir / file / git URL) into a sandbox-ready payload.
 * Always a namespaced (or un-prefixed for cwd) list of ContextFile.
 */
export interface SourceResult {
  readonly payload: readonly ContextFile[];
  readonly files: number;
  /** Sum of raw content lengths — what the model should size batches against. */
  readonly chars: number;
  readonly sourceId: string;
  readonly pathPrefix: string;
  /**
   * Document-type files present in the payload (fresh conversions + cache hits).
   * Distinct from `converted` so a second session over cached PDFs is not "0 documents".
   */
  readonly documents: number;
  /** Documents freshly converted to Markdown this call (cache hits do NOT count). */
  readonly converted: number;
  /** Paths skipped (binary, sensitive, no-converter, …). Capped; unreadable filtered. */
  readonly skipped: readonly SkippedFile[];
}

/** Options shared by every resolve / pack path. */
export interface ResolveOpts {
  readonly cwd: string;
  /**
   * Namespace under which files land. `""` marks the primary/cwd source (un-prefixed paths
   * so search() hits remain real paths edit/write can act on). Omit to derive `ctx/<id>/`.
   */
  readonly pathPrefix?: string;
  readonly signal?: AbortSignal;
}

/** Single-file sources above this must use open() + llm_query_chunked in the REPL. */
export const MAX_CONTEXT_FILE_BYTES = 8 * 1024 * 1024;

/** Per-file text size cap when walking a directory (parity with the old repomix 1MB cap). */
export const MAX_WALK_FILE_BYTES = 1_048_576;

/** Per-document size cap during a directory walk (and single-file document path). */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** Cap on model-facing skipped entries so an asset-heavy repo cannot flood the wire. */
export const MAX_SKIPPED_REPORTED = 64;

/** Catch-all prefix for a raw string payload with no namespace — never an identity key. */
export const LEGACY_UNKNOWN_PREFIX = "ctx/unknown/";
