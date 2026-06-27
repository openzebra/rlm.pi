/**
 * repomix-context — pre-packs the entire codebase into a structured JSON array
 * for the RLM sandbox. Replaces the legacy filesystem-tool context
 * (buildProjectManifest / listProjectFiles / gitLsFiles).
 *
 * Uses repomix internally (worker-thread pool, built-in gitignore support)
 * and caches results in a module-level Map with TTL to avoid re-packing on
 * every run within the same process. `patchContextAfterEdits` updates the
 * cached bundle in-memory after file edits are applied to disk — no re-packing.
 */

import { pack } from "repomix";
import type { PackResult as RepomixPackResult } from "repomix";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { errorMessage } from "../util/errors.ts";

// ── Public types ──

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly tokens: number;
}

export interface ContextBundle {
  readonly files: readonly ContextFile[];
  readonly totalFiles: number;
  readonly totalTokens: number;
  readonly totalChars: number;
}

export interface PackSuccess {
  readonly ok: true;
  readonly value: ContextBundle;
}

export interface PackFailure {
  readonly ok: false;
  readonly error: string;
}

export type PackResult = PackSuccess | PackFailure;

// ── Module-level cache ──

interface CacheEntry {
  readonly bundle: ContextBundle;
  readonly ts: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_CACHE_TTL_MS = 30_000;

/** Exported for tests — empties the module-level cache. */
export function clearCache(): void {
  cache.clear();
}

function cacheKey(cwd: string): string {
  return resolve(cwd);
}

function cacheGet(key: string, ttlMs: number): ContextBundle | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.bundle;
}

function cacheSet(key: string, bundle: ContextBundle): void {
  cache.set(key, { bundle, ts: Date.now() });
}

// ── Core functions ──

const ESTIMATED_CHARS_PER_TOKEN = 4;

export async function packRepository(
  cwd: string,
  signal?: AbortSignal,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<PackResult> {
  if (signal?.aborted) return { ok: false, error: "aborted" };

  const key = cacheKey(cwd);
  const cached = cacheGet(key, ttlMs);
  if (cached) return { ok: true, value: cached };

  try {
    const result: RepomixPackResult = await Promise.race([
      pack([cwd], {
        input: { maxFileSize: 1048576 },
        cwd,
        output: {
          filePath: `${tmpdir()}/repomix-out-${Date.now()}.txt`,
          style: "plain",
          parsableStyle: false,
          headerText: undefined,
          instructionFilePath: undefined,
          fileSummary: false,
          directoryStructure: false,
          files: true,
          removeComments: false,
          removeEmptyLines: false,
          compress: false,
          topFilesLength: 5,
          showLineNumbers: false,
          truncateBase64: false,
          copyToClipboard: false,
          includeEmptyDirectories: undefined,
          includeFullDirectoryStructure: false,
          splitOutput: undefined,
          tokenCountTree: false,
          tokenBudget: undefined,
          git: {
            sortByChanges: true,
            sortByChangesMaxCommits: 100,
            includeDiffs: false,
            includeLogs: false,
            includeLogsCount: 50,
          },
        },
        include: [],
        ignore: {
          useGitignore: true,
          useDotIgnore: true,
          useDefaultPatterns: true,
          customPatterns: [],
        },
        security: { enableSecurityCheck: false },
        tokenCount: { encoding: "o200k_base" as const },
      } as Parameters<typeof pack>[1]),
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);

    const processedFiles = result.processedFiles;
    const files = new Array<ContextFile>(processedFiles.length);
    const tokenCounts = result.fileTokenCounts;
    let totalTokens = 0;
    let totalChars = 0;

    for (let i = 0; i < processedFiles.length; i++) {
      const file = processedFiles[i];
      const tokens = tokenCounts[file.path]
        ?? Math.ceil(file.content.length / ESTIMATED_CHARS_PER_TOKEN);
      files[i] = { path: file.path, content: file.content, tokens };
      totalTokens += tokens;
      totalChars += file.content.length;
    }

    const bundle: ContextBundle = {
      files,
      totalFiles: files.length,
      totalTokens,
      totalChars,
    };
    cacheSet(key, bundle);
    return { ok: true, value: bundle };
  } catch (err: unknown) {
    if (signal?.aborted) return { ok: false, error: "aborted" };
    return {
      ok: false,
      error: errorMessage(err),
    };
  }
}

export function patchContextAfterEdits(
  cached: ContextBundle,
  edits: readonly { readonly path: string; readonly newContent: string }[],
): ContextBundle {
  const editMap = new Map<string, string>();
  for (const edit of edits) {
    editMap.set(edit.path, edit.newContent);
  }

  const files = new Array<ContextFile>(cached.files.length);
  let totalTokens = 0;
  let totalChars = 0;

  for (let i = 0; i < cached.files.length; i++) {
    const file = cached.files[i];
    const newContent = editMap.get(file.path);
    if (newContent !== undefined) {
      const tokens = Math.ceil(newContent.length / ESTIMATED_CHARS_PER_TOKEN);
      files[i] = { path: file.path, content: newContent, tokens };
      totalTokens += tokens;
      totalChars += newContent.length;
    } else {
      files[i] = file;
      totalTokens += file.tokens;
      totalChars += file.content.length;
    }
  }

  return {
    files,
    totalFiles: files.length,
    totalTokens,
    totalChars,
  };
}

export function serializeForSandbox(
  bundle: ContextBundle,
): readonly ContextFile[] {
  return bundle.files;
}

/** Maximum files shown in the compact LLM listing before truncation. */
const MAX_LLM_LISTING_FILES = 200;

/**
 * Produces a compact human-readable text block for the parent LLM's context window.
 * Shows file paths and token estimates — NOT full file contents (those are too large
 * for the context window). The LLM uses its file-reading tools to inspect specific files.
 */
export function formatForLLM(bundle: ContextBundle): string {
  const files = bundle.files.slice(0, MAX_LLM_LISTING_FILES);
  const truncated = bundle.totalFiles > MAX_LLM_LISTING_FILES
    ? `... and ${bundle.totalFiles - MAX_LLM_LISTING_FILES} more files (truncated)`
    : "";

  const listing = files.map((f) =>
    `${f.path} (${f.tokens.toLocaleString()} tok, ${f.content.length.toLocaleString()} chars)`,
  ).join("\n");

  return [
    `Repository context: ${bundle.totalFiles.toLocaleString()} files, ${bundle.totalTokens.toLocaleString()} estimated tokens, ${bundle.totalChars.toLocaleString()} total characters.`,
    "",
    listing,
    truncated,
    "",
    "To read a file, use the file-reading tools with the exact path.",
  ].join("\n");
}

export function patchCachedContext(
  cwd: string,
  edits: readonly { readonly path: string; readonly newContent: string }[],
): void {
  const key = cacheKey(cwd);
  const entry = cache.get(key);
  if (!entry) return;
  const patched = patchContextAfterEdits(entry.bundle, edits);
  cache.set(key, { bundle: patched, ts: entry.ts });
}
