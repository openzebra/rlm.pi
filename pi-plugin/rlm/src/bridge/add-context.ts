/**
 * Shared add_context handler for headless engine and native repl() mode.
 *
 * Host packs the source via resolveSource (namespaced under ctx/<id>/) and returns the
 * payload for the worker to append into the single `context` list.
 *
 * Idempotency is host-side:
 *  - prefix set (ctx/<id>/) for external sources
 *  - cwd seed: markSeededCwd + exact-path short-circuit for add_context(".")
 *  - subpath of seed: short-circuit only when the live context already holds un-prefixed
 *    entries under that relative path (gitignored subtrees still pack for real)
 *
 * Late-bound deps (getCwd / getEmitter) keep a single handler closure correct
 * across native repl() calls — getOrCreate only installs handlers at spawn.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import {
  contextNamespace,
  isContextFile,
} from "../context/namespace.ts";
import { resolveSource } from "../context/resolve.ts";
import { previewText } from "../text/preview.ts";

export interface AddContextBridgeOpts {
  /** Fixed cwd (headless). Prefer getCwd when the sandbox outlives a single invocation. */
  readonly cwd?: string;
  /** Late-bound cwd (native mode — sandbox handlers outlive a single repl()). */
  readonly getCwd?: () => string;
  readonly emitter?: RlmEmitter;
  /** Native mode: read the live emitter each call. */
  readonly getEmitter?: () => RlmEmitter | null | undefined;
  readonly parentId?: string;
  readonly signal?: AbortSignal;
  /** Prefixes already present in context — seeds host-side idempotency after a sandbox restart. */
  readonly loadedPrefixes?: readonly string[];
  /**
   * The live context this sandbox holds. Read to refuse pre-flight exactly what the worker's
   * `_append_context` would reject, before any prefix is committed.
   */
  readonly getContext?: () => unknown;
  /**
   * Post-load hook. The engine grows its live context here; native mode grows
   * SandboxManager.contextPayload.
   */
  readonly onLoaded?: (payload: unknown) => void | Promise<void>;
}

export interface AddContextHandlerBundle {
  readonly handlers: Pick<SubLlmHandlers, "addContext">;
  /**
   * Reset the loaded-prefix cache (call when the sandbox is
   * discarded and will re-spawn).
   *
   * `keep` re-seeds the cache from the payload that will be replayed into the fresh worker.
   * `loaded` is a CACHE of `contextPrefixesIn(context)` plus the cwd sentinel `""`, never
   * independent state, so it may only be cleared by re-deriving it — clearing it outright
   * would make the host re-clone a source the recreated worker already holds.
   */
  readonly reset: (keep?: readonly string[]) => void;
  /**
   * Register a prefix as already loaded without packing. Used by the cwd seed to plant the
   * `""` sentinel so add_context of the same tree is a no-op.
   */
  readonly markLoaded: (prefix: string) => void;
  /**
   * Record the absolute path of the cwd seed. add_context(".") resolves to a ctx/<id>/
   * namespace, not "", so the absolute-path check is the only reliable short-circuit.
   */
  readonly markSeededCwd: (absPath: string) => void;
  /** Prefixes loaded in this sandbox lifetime (for tests). */
  readonly loadedPrefixes: () => ReadonlySet<string>;
  /** Absolute seeded cwd, if any (for tests). */
  readonly seededCwd: () => string | undefined;
}

/**
 * JS runtime kind → the Python type name worker.py reports, so both sides emit exactly one
 * message for the same refusal. Covers every shape a context payload can take after JSON
 * transport; anything else is a plain object, which `json.load` materializes as a dict.
 */
const PY_TYPE_NAME: Readonly<Record<string, string>> = Object.freeze({
  string: "str", boolean: "bool", number: "int", bigint: "int", undefined: "None",
});

function pythonKindOf(value: unknown): string {
  if (value === null) return "None"; // matches worker.py's `if ctx is not None else "None"`
  return PY_TYPE_NAME[typeof value] ?? "dict";
}

/**
 * Refusal messages shared with worker.py `_append_context`. The worker is the backstop; the host
 * pre-flights the same two conditions so it never commits a prefix for an append that
 * will be rejected. Keep the wording identical — a comment in worker.py points back here.
 */
const LIST_CONTEXT_REQUIRED = (kind: string): string =>
  `add_context requires list context (file bundle); got ${kind}`;
const NO_FILES_PRODUCED = "add_context produced no files";

/** Absolute path with no trailing slash (except root). */
function absKey(path: string): string {
  const resolved = resolve(path);
  return resolved.length > 1 && (resolved.endsWith("/") || resolved.endsWith("\\"))
    ? resolved.slice(0, -1)
    : resolved;
}

/**
 * True when the live context already holds un-prefixed (cwd-seed) entries under `relPrefix`.
 * Used so add_context("./src/context") does not double-load a subpath that the seed already
 * has — without blocking genuinely-absent (gitignored) subtrees.
 */
function contextHasUnprefixedUnder(context: unknown, relPrefix: string): boolean {
  if (!Array.isArray(context) || relPrefix === "") return false;
  const clean = relPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean === "" || clean.startsWith("..")) return false;
  const withSlash = `${clean}/`;
  for (let i = 0; i < context.length; i++) {
    const entry: unknown = context[i];
    if (!isContextFile(entry)) continue;
    // Only cwd-seed paths are un-prefixed; ctx/<id>/… is a different source.
    if (entry.path.startsWith("ctx/")) continue;
    if (entry.path === clean || entry.path.startsWith(withSlash)) return true;
  }
  return false;
}

function alreadyLoadedResult(
  sourceId: string,
  pathPrefix: string,
): Awaited<ReturnType<SubLlmHandlers["addContext"]>> {
  return {
    payload: Object.freeze([]),
    files: 0,
    chars: 0,
    sourceId,
    pathPrefix,
    alreadyLoaded: true,
    documents: 0,
    converted: 0,
    skipped: Object.freeze([]),
  };
}

export function buildAddContextHandler(opts: AddContextBridgeOpts): AddContextHandlerBundle {
  /** Prefixes already loaded in this sandbox — mirrors the worker's context state. */
  const loaded = new Set<string>(opts.loadedPrefixes ?? []);
  /** Absolute path of the cwd seed, if autoSeedCwd planted one successfully. */
  let seededCwdAbs: string | undefined;
  return {
    reset: (keep) => {
      const seed = keep ?? opts.loadedPrefixes ?? [];
      loaded.clear();
      for (const prefix of seed) loaded.add(prefix);
      // Do NOT clear seededCwdAbs — the payload is still on disk in the manager and will be
      // replayed; the absolute-path short-circuit must keep working after a death-recreate.
    },
    markLoaded: (prefix) => { loaded.add(prefix); },
    markSeededCwd: (absPath) => {
      seededCwdAbs = absKey(absPath);
      loaded.add(""); // cwd sentinel — payloadPrefix never sees un-prefixed files
    },
    loadedPrefixes: () => loaded,
    seededCwd: () => seededCwdAbs,
    handlers: {
      async addContext(source, depth) {
        const emitter = opts.getEmitter?.() ?? opts.emitter;
        const cwd = opts.getCwd?.() ?? opts.cwd;
        if (cwd === undefined || cwd === "") {
          throw new Error("add_context: no cwd configured");
        }
        const id = emitter?.emitSubcallCreated({
          kind: "tool", parentId: opts.parentId,
          label: "add_context",
          args: previewText(source, 80),
          depth,
        });
        try {
          // Pre-flight the worker's own refusal: a non-list context cannot be appended to, and
          // committing a prefix for it would make the NEXT load lie with already_loaded.
          const current = opts.getContext?.();
          if (current !== undefined && !Array.isArray(current)) {
            throw new Error(LIST_CONTEXT_REQUIRED(pythonKindOf(current)));
          }

          const trimmed = source.trim();
          const isLocal = trimmed !== "" && !/^(https:\/\/|git@)/.test(trimmed)
            && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
          const candidate = isLocal
            ? absKey(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed))
            : undefined;
          const cwdAbs = absKey(cwd);

          // ── Cwd seed short-circuit / recovery ──
          // Exact cwd: if already seeded → no-op; if seed failed (sticky, no markSeededCwd)
          // pack un-prefixed so paths stay edit/write-friendly.
          if (candidate !== undefined && candidate === cwdAbs) {
            if (seededCwdAbs !== undefined) {
              if (id) {
                emitter?.emitSubcallUpdated({
                  id, status: "done", resultPreview: "already loaded (cwd seed)",
                });
              }
              return alreadyLoadedResult("cwd", "");
            }
            // Recovery after failed seed (or autoSeedCwd off): pack as primary, un-prefixed.
            const recovered = await resolveSource(source, {
              cwd, pathPrefix: "", signal: opts.signal,
            });
            if (!recovered.ok) throw new Error(recovered.error);
            const r = recovered.value;
            if (r.payload.length === 0) throw new Error(NO_FILES_PRODUCED);
            if (opts.onLoaded) await opts.onLoaded(r.payload);
            seededCwdAbs = cwdAbs;
            loaded.add("");
            if (id) {
              emitter?.emitSubcallUpdated({
                id, status: "done",
                resultPreview: `+${r.files} file(s) → context (cwd seed recovery, ${r.chars.toLocaleString()} chars)`,
              });
            }
            return {
              payload: r.payload,
              files: r.files,
              chars: r.chars,
              sourceId: r.sourceId,
              pathPrefix: "",
              alreadyLoaded: false,
              documents: r.documents,
              converted: r.converted,
              skipped: r.skipped,
            };
          }

          // Subpath of the seeded cwd: only short-circuit when those files are already in
          // context (un-prefixed). A gitignored subtree that the seed never had still packs.
          if (candidate !== undefined && seededCwdAbs !== undefined
            && candidate !== seededCwdAbs
            && (candidate.startsWith(seededCwdAbs + sep) || candidate.startsWith(seededCwdAbs + "/"))) {
            const rel = relative(seededCwdAbs, candidate).split(sep).join("/");
            if (rel !== "" && !rel.startsWith("..") && contextHasUnprefixedUnder(current, rel)) {
              if (id) {
                emitter?.emitSubcallUpdated({
                  id, status: "done",
                  resultPreview:
                    `already in cwd seed under '${rel}/' — filter context by path prefix`,
                });
              }
              return alreadyLoadedResult("cwd", "");
            }
          }

          // Cheap pre-check BEFORE cloning/packing: same namespace ⇒ nothing to do.
          const { sourceId: preId, pathPrefix: prefix } = contextNamespace(source, cwd);
          if (loaded.has(prefix)) {
            if (id) {
              emitter?.emitSubcallUpdated({
                id,
                status: "done",
                resultPreview: `already loaded (${prefix}*)`,
              });
            }
            return alreadyLoadedResult(preId, prefix);
          }

          const resolved = await resolveSource(source, { cwd, signal: opts.signal });
          if (!resolved.ok) throw new Error(resolved.error);
          const { payload, files, chars, sourceId, pathPrefix, documents, converted, skipped } =
            resolved.value;
          // The worker's other refusal, pre-flighted for the same reason.
          if (payload.length === 0) throw new Error(NO_FILES_PRODUCED);

          // Race: another concurrent load of the same prefix finished while we packed.
          if (loaded.has(pathPrefix)) {
            if (id) {
              emitter?.emitSubcallUpdated({
                id,
                status: "done",
                resultPreview: `already loaded (${pathPrefix}*)`,
              });
            }
            return alreadyLoadedResult(sourceId, pathPrefix);
          }

          // Mark loaded only after the host has grown its own copy of the context.
          if (opts.onLoaded) {
            await opts.onLoaded(payload);
          }
          loaded.add(pathPrefix);

          if (id) {
            const docNote = documents > 0
              ? `, ${documents} doc(s)${converted > 0 ? ` (${converted} fresh)` : " (cached)"}`
              : "";
            emitter?.emitSubcallUpdated({
              id,
              status: "done",
              resultPreview:
                `+${files} file(s) → context (${pathPrefix}*, ${chars.toLocaleString()} chars${docNote})`,
            });
          }
          return {
            payload,
            files,
            chars,
            sourceId,
            pathPrefix,
            alreadyLoaded: false,
            documents,
            converted,
            skipped,
          };
        } catch (err) {
          if (id) emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
          throw err;   // serviceInterrupt catch → {error} reply → "Error: …" in the REPL
        }
      },
    },
  };
}
