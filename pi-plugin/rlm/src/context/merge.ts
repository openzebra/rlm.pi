/**
 * Merge / filter helpers for the live context list.
 *
 * Lifted from the old library-context module with `lib/` → `ctx/` and the empty-prefix
 * short-circuit for cwd sources.
 */

import { estimateTokens } from "../text/tokens.ts";
import {
  contextEntryPath,
  isContextFile,
  namespaceContextFiles,
  payloadPrefix,
} from "./namespace.ts";
import type { ContextFile } from "./types.ts";

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
 * Append a source payload into an existing list context.
 * Skips a payload whose `ctx/<id>/` prefix is already present, so a repeat load is a no-op.
 *
 * Cwd-seeded (un-prefixed) files never carry a `ctx/<id>/` prefix, so `payloadPrefix` returns
 * undefined for them and this path-scan does not fire. Idempotency for the cwd seed is owned
 * by the host `loaded` set (sentinel `""`) and the seeded-cwd absolute-path short-circuit in
 * bridge/add-context.ts — not by this merge.
 */
export function mergeIntoContext(base: unknown, sourcePayload: unknown): unknown {
  if (!Array.isArray(base)) return base;
  if (Array.isArray(sourcePayload)) {
    if (sourcePayload.length === 0) return base;
    const prefix = payloadPrefix(sourcePayload);
    // Only `ctx/<id>/` prefixes participate in path-scan dedup (payloadPrefix never returns "").
    if (prefix !== undefined) {
      for (let i = 0; i < base.length; i++) {
        const path = contextEntryPath(base[i]);
        if (path !== undefined && path.startsWith(prefix)) return base; // already present
      }
    }
    const merged = new Array<unknown>(base.length + sourcePayload.length);
    for (let i = 0; i < base.length; i++) merged[i] = base[i];
    for (let i = 0; i < sourcePayload.length; i++) merged[base.length + i] = sourcePayload[i];
    return merged;
  }
  if (typeof sourcePayload === "string") {
    // Raw string payload: wrap once under the unknown prefix.
    return mergeIntoContext(base, namespaceContextFiles(sourcePayload, "unknown"));
  }
  return base;
}

/** Build a frozen ContextFile from path + content (shared by every source-* producer). */
export function makeContextFile(path: string, content: string): ContextFile {
  return Object.freeze({
    path,
    content,
    tokens: Math.max(1, estimateTokens(content.length)),
  });
}
