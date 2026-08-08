/**
 * Resolve load_library(source) into a sandbox-ready payload.
 *
 * Sources: local directory (repomix-packed), single file (utf-8), or remote git URL
 * (shallow clone then pack). Host-side only — never runs in the sandbox.
 *
 * Every successful payload is a namespaced list of ContextFile under
 * `lib/<source_id>/…` so the worker can append into the single `context` variable.
 * Source ids include a short content fingerprint so two libraries that share a
 * basename never collide.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  packRepository,
  serializeForSandbox,
  type ContextBundle,
  type ContextFile,
} from "./repomix-context.ts";
import { estimateTokens } from "../text/tokens.ts";
import type { Result } from "../util/errors.ts";
import { errorMessage } from "../util/errors.ts";

const execFileP = promisify(execFile);

/** Single-file sources above this must use open() + llm_query_chunked in the REPL. */
export const MAX_LIBRARY_FILE_BYTES = 8 * 1024 * 1024;

/** Legacy catch-all prefix for pre-namespace string sidecars — never an identity key. */
const LEGACY_UNKNOWN_PREFIX = "lib/unknown/";

export interface LibrarySource {
  /** Always a namespaced file list (dirs, single files, and git clones). */
  readonly payload: readonly ContextFile[];
  readonly files: number;
  /** Sum of raw content lengths — what the model should size batches against. */
  readonly chars: number;
  readonly sourceId: string;
  readonly pathPrefix: string;
}

export interface LibraryNamespace {
  readonly sourceId: string;
  readonly pathPrefix: string;
}

/** https://host/… or git@host:… — option-injection safe (never starts with "-"). */
const GIT_URL = /^(https:\/\/|git@)[\w.-]+[:/]\S+$/;

/** Short, stable discriminator so two sources never share a namespace. */
function sourceFingerprint(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/**
 * Sanitize a path/url basename into a stable, filesystem-safe source id.
 * `resolvedPath` (absolute path) or the git URL is fingerprinted into the id so
 * distinct sources sharing a basename get distinct namespaces
 * (`lib/utils-3f9a1c02/` vs `lib/utils-a1b2c3d4/`).
 */
export function librarySourceId(source: string, resolvedPath?: string): string {
  const trimmed = source.trim();
  const isGit = GIT_URL.test(trimmed);
  let raw: string;
  if (isGit) {
    const m = trimmed.match(/(?:\/|:)([\w.-]+?)(?:\.git)?\/?\s*$/);
    raw = m?.[1] ?? "repo";
  } else {
    raw = basename(resolvedPath ?? trimmed);
  }
  const cleaned = raw
    .replace(/\.git$/i, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const canonical = isGit ? trimmed : (resolvedPath ?? trimmed);
  return `${cleaned.length > 0 ? cleaned : "lib"}-${sourceFingerprint(canonical)}`;
}

export function pathPrefixFor(sourceId: string): string {
  return `lib/${sourceId}/`;
}

/**
 * Derive the namespace for a source string without packing (host-side idempotency).
 * Returns both sourceId and pathPrefix so callers never un-parse the prefix.
 */
export function libraryNamespace(source: string, cwd: string): LibraryNamespace {
  const trimmed = source.trim();
  const sourceId = GIT_URL.test(trimmed)
    ? librarySourceId(trimmed)
    : librarySourceId(trimmed, isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
  return Object.freeze({ sourceId, pathPrefix: pathPrefixFor(sourceId) });
}

/** Derive the path prefix for a source string without packing. */
export function libraryPathPrefix(source: string, cwd: string): string {
  return libraryNamespace(source, cwd).pathPrefix;
}

/** Namespaced files plus summed content chars (one pass). */
export function namespaceLibraryFilesWithChars(
  payload: unknown,
  sourceId: string,
): { readonly files: readonly ContextFile[]; readonly chars: number } {
  const prefix = pathPrefixFor(sourceId);
  if (typeof payload === "string") {
    return Object.freeze({
      files: Object.freeze([
        Object.freeze({
          path: `${prefix}content`,
          content: payload,
          tokens: Math.max(1, estimateTokens(payload.length)),
        }),
      ]),
      chars: payload.length,
    });
  }
  if (!Array.isArray(payload)) return Object.freeze({ files: Object.freeze([]), chars: 0 });
  const out = new Array<ContextFile>(payload.length);
  let n = 0;
  let chars = 0;
  for (const item of payload) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const content = typeof rec.content === "string" ? rec.content : String(rec.content ?? "");
    let path = typeof rec.path === "string" ? rec.path : "unknown";
    path = path.replace(/^\/+/, "");
    if (!path.startsWith(prefix)) path = `${prefix}${path}`;
    const tokens = typeof rec.tokens === "number" && Number.isFinite(rec.tokens)
      ? Math.max(0, Math.floor(rec.tokens))
      : Math.max(1, estimateTokens(content.length));
    out[n++] = Object.freeze({ path, content, tokens });
    chars += content.length;
  }
  out.length = n;
  return Object.freeze({ files: Object.freeze(out), chars });
}

/** Namespace file entries under `lib/<sourceId>/…` (single shared implementation). */
export function namespaceLibraryFiles(
  payload: unknown,
  sourceId: string,
): readonly ContextFile[] {
  return namespaceLibraryFilesWithChars(payload, sourceId).files;
}

/** The one `lib/<id>/` matcher. Never re-declare this regex; use the helpers below. */
const LIB_PREFIX_RE = /^(lib\/[^/]+\/)/;

/** Narrow an unknown context entry to a ContextFile. Type guard, never a cast. */
export function isContextFile(entry: unknown): entry is ContextFile {
  if (entry === null || typeof entry !== "object") return false;
  return "path" in entry && typeof entry.path === "string"
    && "content" in entry && typeof entry.content === "string";
}

/** `path` of a context entry, or undefined when the entry is not file-shaped. */
export function contextEntryPath(entry: unknown): string | undefined {
  return isContextFile(entry) ? entry.path : undefined;
}

/** The `lib/<id>/` prefix owning this path, or undefined. Skips the legacy catch-all. */
function libPrefixOf(path: string): string | undefined {
  const prefix = LIB_PREFIX_RE.exec(path)?.[1];
  // `lib/unknown/` is the legacy catch-all: never treat it as an identity.
  return prefix === undefined || prefix === LEGACY_UNKNOWN_PREFIX ? undefined : prefix;
}

/** First `lib/<id>/` prefix found in the payload, or undefined. Skips `lib/unknown/`. */
export function payloadPrefix(payload: readonly unknown[]): string | undefined {
  for (let i = 0; i < payload.length; i++) {
    const path = contextEntryPath(payload[i]);
    if (path === undefined) continue;
    const prefix = libPrefixOf(path);
    if (prefix !== undefined) return prefix;
  }
  return undefined;
}

/**
 * Every distinct `lib/<id>/` prefix present in a context payload.
 *
 * The loaded-prefix set in bridge/library.ts is a CACHE of this — derived state, never
 * independent state, so it may only be cleared by re-deriving it from the live payload.
 */
export function libraryPrefixesIn(context: unknown): readonly string[] {
  if (!Array.isArray(context)) return Object.freeze([]);
  const seen = new Set<string>();
  for (let i = 0; i < context.length; i++) {
    const path = contextEntryPath(context[i]);
    if (path === undefined) continue;
    const prefix = libPrefixOf(path);
    if (prefix !== undefined) seen.add(prefix);
  }
  return Object.freeze(Array.from(seen));
}

export interface FilteredContext {
  readonly files: readonly ContextFile[];
  /** Prefixes that selected zero files — the caller decides whether that is fatal. */
  readonly unmatched: readonly string[];
}

/**
 * Narrow a context payload to entries under any of `prefixes` (plain prefix match, no globs).
 *
 * Backs `rlm_query(prompt, paths=[…])`. Prefix-only is deliberate: the sandbox's own filters use
 * Python `fnmatch`, which has no host-side equivalent here, and a subtree prefix is what callers
 * actually want — the child can still `search()` inside the slice.
 */
export function filterContextByPaths(context: unknown, prefixes: readonly string[]): FilteredContext {
  if (!Array.isArray(context) || prefixes.length === 0) {
    return Object.freeze({ files: Object.freeze([]), unmatched: Object.freeze(Array.from(prefixes)) });
  }
  const hit = new Array<boolean>(prefixes.length).fill(false);
  const out = new Array<ContextFile>(context.length); // pre-allocated, trimmed once below
  let n = 0;
  for (let i = 0; i < context.length; i++) {
    const entry: unknown = context[i];
    if (!isContextFile(entry)) continue;
    for (let p = 0; p < prefixes.length; p++) {
      if (!entry.path.startsWith(prefixes[p])) continue;
      hit[p] = true;
      out[n++] = entry;
      break;
    }
  }
  out.length = n;
  const unmatched = new Array<string>(prefixes.length); // pre-allocated, no .push()
  let u = 0;
  for (let p = 0; p < prefixes.length; p++) {
    if (!hit[p]) unmatched[u++] = prefixes[p];
  }
  unmatched.length = u;
  return Object.freeze({ files: Object.freeze(out), unmatched: Object.freeze(unmatched) });
}

/**
 * Append a library payload into an existing list context (host-side resume merge).
 * Skips a payload whose path prefix is already present (resume-safe dedup).
 */
export function mergeLibraryIntoContext(base: unknown, libraryPayload: unknown): unknown {
  if (!Array.isArray(base)) return base;
  if (Array.isArray(libraryPayload)) {
    if (libraryPayload.length === 0) return base;
    const prefix = payloadPrefix(libraryPayload);
    if (prefix !== undefined) {
      for (let i = 0; i < base.length; i++) {
        const path = contextEntryPath(base[i]);
        if (path !== undefined && path.startsWith(prefix)) return base; // already present
      }
    }
    const merged = new Array<unknown>(base.length + libraryPayload.length);
    for (let i = 0; i < base.length; i++) merged[i] = base[i];
    for (let i = 0; i < libraryPayload.length; i++) merged[base.length + i] = libraryPayload[i];
    return merged;
  }
  if (typeof libraryPayload === "string") {
    // Legacy string sidecars: wrap once under an unknown prefix.
    return mergeLibraryIntoContext(base, namespaceLibraryFiles(libraryPayload, "unknown"));
  }
  return base;
}

function toLibrarySource(payload: unknown, sourceId: string): LibrarySource {
  const { files, chars } = namespaceLibraryFilesWithChars(payload, sourceId);
  return {
    payload: files,
    files: files.length,
    chars,
    sourceId,
    pathPrefix: pathPrefixFor(sourceId),
  };
}

export async function resolveLibrarySource(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result<LibrarySource, string>> {
  const trimmed = source.trim();
  if (trimmed === "") return { ok: false, error: "load_library: empty source" };
  if (GIT_URL.test(trimmed)) return await cloneAndPack(trimmed, signal);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, error: `unsupported URL scheme (only https:// and git@ are allowed): ${trimmed}` };
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch {
    return { ok: false, error: `load_library: path not found: ${path}` };
  }
  const sourceId = librarySourceId(trimmed, path);
  if (s.isDirectory()) return await packDir(path, sourceId, signal);
  if (s.size > MAX_LIBRARY_FILE_BYTES) {
    return {
      ok: false,
      error: `load_library: ${path} is ${s.size.toLocaleString()} bytes `
        + `(limit ${MAX_LIBRARY_FILE_BYTES.toLocaleString()}) — `
        + "open() it in the REPL and delegate with llm_query_chunked instead",
    };
  }
  const text = await readFile(path, "utf-8");
  return { ok: true, value: toLibrarySource(text, sourceId) };
}

async function packDir(
  dir: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<Result<LibrarySource, string>> {
  const packed = await packRepository(dir, signal);
  if (!packed.ok) return { ok: false, error: `pack failed for ${dir} — ${packed.error}` };
  return { ok: true, value: bundleToSource(packed.value, sourceId) };
}

function bundleToSource(bundle: ContextBundle, sourceId: string): LibrarySource {
  return toLibrarySource(serializeForSandbox(bundle), sourceId);
}

async function cloneAndPack(url: string, signal?: AbortSignal): Promise<Result<LibrarySource, string>> {
  const dir = await mkdtemp(join(tmpdir(), "rlm-lib-"));
  const sourceId = librarySourceId(url);
  try {
    await execFileP("git", ["clone", "--depth", "1", "--", url, dir], { signal, timeout: 120_000 });
    return await packDir(dir, sourceId, signal);
  } catch (err: unknown) {
    return { ok: false, error: `git clone failed for ${url} — ${errorMessage(err)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
