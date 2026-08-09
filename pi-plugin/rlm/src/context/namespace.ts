/**
 * Source-id / path-prefix derivation for add_context sources.
 *
 * Lifted from the old library-context module with `lib/` → `ctx/`. Fingerprinted source ids
 * keep two sources that share a basename from colliding.
 */

import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { estimateTokens } from "../text/tokens.ts";
import { LEGACY_UNKNOWN_PREFIX, type ContextFile } from "./types.ts";

export interface ContextNamespace {
  readonly sourceId: string;
  readonly pathPrefix: string;
}

/** https://host/… or git@host:… — option-injection safe (never starts with "-"). */
export const GIT_URL = /^(https:\/\/|git@)[\w.-]+[:/]\S+$/;

/** Short, stable discriminator so two sources never share a namespace. */
function sourceFingerprint(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/**
 * Sanitize a path/url basename into a stable, filesystem-safe source id.
 * `resolvedPath` (absolute path) or the git URL is fingerprinted into the id so
 * distinct sources sharing a basename get distinct namespaces
 * (`ctx/utils-3f9a1c02/` vs `ctx/utils-a1b2c3d4/`).
 */
export function contextSourceId(source: string, resolvedPath?: string): string {
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
  return `${cleaned.length > 0 ? cleaned : "ctx"}-${sourceFingerprint(canonical)}`;
}

export function pathPrefixFor(sourceId: string): string {
  return `ctx/${sourceId}/`;
}

/**
 * Derive the namespace for a source string without packing (host-side idempotency).
 * Returns both sourceId and pathPrefix so callers never un-parse the prefix.
 */
export function contextNamespace(source: string, cwd: string): ContextNamespace {
  const trimmed = source.trim();
  const sourceId = GIT_URL.test(trimmed)
    ? contextSourceId(trimmed)
    : contextSourceId(trimmed, isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
  return Object.freeze({ sourceId, pathPrefix: pathPrefixFor(sourceId) });
}

/** Derive the path prefix for a source string without packing. */
export function contextPathPrefix(source: string, cwd: string): string {
  return contextNamespace(source, cwd).pathPrefix;
}

/**
 * Apply a path prefix. Empty prefix is identity — the cwd source stays un-prefixed so
 * search() hits remain real paths that edit/write can act on.
 */
export function applyPathPrefix(relPath: string, pathPrefix: string): string {
  const cleaned = relPath.replace(/^\/+/, "");
  if (pathPrefix === "") return cleaned;
  if (cleaned.startsWith(pathPrefix)) return cleaned;
  return `${pathPrefix}${cleaned}`;
}

/** Namespaced files plus summed content chars (one pass). */
export function namespaceContextFilesWithChars(
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
    path = applyPathPrefix(path, prefix);
    const tokens = typeof rec.tokens === "number" && Number.isFinite(rec.tokens)
      ? Math.max(0, Math.floor(rec.tokens))
      : Math.max(1, estimateTokens(content.length));
    out[n++] = Object.freeze({ path, content, tokens });
    chars += content.length;
  }
  out.length = n;
  return Object.freeze({ files: Object.freeze(out), chars });
}

/** Namespace file entries under `ctx/<sourceId>/…` (single shared implementation). */
export function namespaceContextFiles(
  payload: unknown,
  sourceId: string,
): readonly ContextFile[] {
  return namespaceContextFilesWithChars(payload, sourceId).files;
}

/** The one `ctx/<id>/` matcher. Never re-declare this regex; use the helpers below. */
const CTX_PREFIX_RE = /^(ctx\/[^/]+\/)/;

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

/** The `ctx/<id>/` prefix owning this path, or undefined. Skips the legacy catch-all. */
function ctxPrefixOf(path: string): string | undefined {
  const prefix = CTX_PREFIX_RE.exec(path)?.[1];
  // `ctx/unknown/` is the legacy catch-all: never treat it as an identity.
  return prefix === undefined || prefix === LEGACY_UNKNOWN_PREFIX ? undefined : prefix;
}

/** First `ctx/<id>/` prefix found in the payload, or undefined. Skips `ctx/unknown/`. */
export function payloadPrefix(payload: readonly unknown[]): string | undefined {
  for (let i = 0; i < payload.length; i++) {
    const path = contextEntryPath(payload[i]);
    if (path === undefined) continue;
    const prefix = ctxPrefixOf(path);
    if (prefix !== undefined) return prefix;
  }
  return undefined;
}

/**
 * Every distinct `ctx/<id>/` prefix present in a context payload.
 *
 * The loaded-prefix set in bridge/add-context.ts is a CACHE of this — derived state, never
 * independent state, so it may only be cleared by re-deriving it from the live payload.
 * Empty-prefix (cwd) sources are intentionally invisible here — the host `loaded` set holds
 * `""` as its sentinel for those.
 */
export function contextPrefixesIn(context: unknown): readonly string[] {
  if (!Array.isArray(context)) return Object.freeze([]);
  const seen = new Set<string>();
  for (let i = 0; i < context.length; i++) {
    const path = contextEntryPath(context[i]);
    if (path === undefined) continue;
    const prefix = ctxPrefixOf(path);
    if (prefix !== undefined) seen.add(prefix);
  }
  return Object.freeze(Array.from(seen));
}
