/**
 * Shared load_library handler for headless engine and native repl() mode.
 *
 * Host packs the source via resolveLibrarySource (namespaced under lib/<id>/) and returns the
 * payload for the worker to append into the single `context` list.
 *
 * Idempotency is host-side: re-loading a source that was already packed does not re-clone or
 * re-pack, and the prefix set is the only state that decides it.
 *
 * Late-bound deps (getCwd / getEmitter) keep a single handler closure correct
 * across native repl() calls — getOrCreate only installs handlers at spawn.
 */

import type { RlmEmitter } from "../tool/rlm-events.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import {
  libraryNamespace,
  resolveLibrarySource,
} from "../context/library-context.ts";
import { previewText } from "../text/preview.ts";

export interface LibraryBridgeOpts {
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
   * `_append_library` would reject, before any prefix is committed.
   */
  readonly getContext?: () => unknown;
  /**
   * Post-load hook. The engine grows its live context here; native mode grows
   * SandboxManager.contextPayload.
   */
  readonly onLoaded?: (payload: unknown) => void | Promise<void>;
}

export interface LibraryHandlerBundle {
  readonly handlers: Pick<SubLlmHandlers, "loadLibrary">;
  /**
   * Reset the loaded-prefix cache (call when the sandbox is
   * discarded and will re-spawn).
   *
   * `keep` re-seeds the cache from the payload that will be replayed into the fresh worker.
   * `loaded` is a CACHE of `libraryPrefixesIn(context)`, never independent state, so it may only
   * be cleared by re-deriving it — clearing it outright would make the host re-clone and re-pack
   * a library the recreated worker already holds.
   */
  readonly reset: (keep?: readonly string[]) => void;
  /** Prefixes loaded in this sandbox lifetime (for tests). */
  readonly loadedPrefixes: () => ReadonlySet<string>;
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
 * Refusal messages shared with worker.py `_append_library`. The worker is the backstop; the host
 * pre-flights the same two conditions so it never commits a prefix for an append that
 * will be rejected. Keep the wording identical — a comment in worker.py points back here.
 */
const LIST_CONTEXT_REQUIRED = (kind: string): string =>
  `load_library requires list context (file bundle); got ${kind}`;
const NO_FILES_PRODUCED = "load_library produced no files";

export function buildLibraryHandler(opts: LibraryBridgeOpts): LibraryHandlerBundle {
  /** Prefixes already loaded in this sandbox — mirrors the worker's context state. */
  const loaded = new Set<string>(opts.loadedPrefixes ?? []);
  return {
    reset: (keep) => {
      const seed = keep ?? opts.loadedPrefixes ?? [];
      loaded.clear();
      for (const prefix of seed) loaded.add(prefix);
    },
    loadedPrefixes: () => loaded,
    handlers: {
      async loadLibrary(source, depth) {
        const emitter = opts.getEmitter?.() ?? opts.emitter;
        const cwd = opts.getCwd?.() ?? opts.cwd;
        if (cwd === undefined || cwd === "") {
          throw new Error("load_library: no cwd configured");
        }
        const id = emitter?.emitSubcallCreated({
          kind: "tool", parentId: opts.parentId,
          label: "load_library",
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

          // Cheap pre-check BEFORE cloning/packing: same namespace ⇒ nothing to do.
          const { sourceId: preId, pathPrefix: prefix } = libraryNamespace(source, cwd);
          if (loaded.has(prefix)) {
            if (id) {
              emitter?.emitSubcallUpdated({
                id,
                status: "done",
                resultPreview: `already loaded (${prefix}*)`,
              });
            }
            return {
              payload: Object.freeze([]),
              files: 0,
              chars: 0,
              sourceId: preId,
              pathPrefix: prefix,
              alreadyLoaded: true,
            };
          }

          const resolved = await resolveLibrarySource(source, cwd, opts.signal);
          if (!resolved.ok) throw new Error(resolved.error);
          const { payload, files, chars, sourceId, pathPrefix } = resolved.value;
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
            return {
              payload: Object.freeze([]),
              files: 0,
              chars: 0,
              sourceId,
              pathPrefix,
              alreadyLoaded: true,
            };
          }

          // Mark loaded only after the host has grown its own copy of the context.
          if (opts.onLoaded) {
            await opts.onLoaded(payload);
          }
          loaded.add(pathPrefix);

          if (id) {
            emitter?.emitSubcallUpdated({
              id,
              status: "done",
              resultPreview:
                `+${files} file(s) → context (${pathPrefix}*, ${chars.toLocaleString()} chars)`,
            });
          }
          return {
            payload,
            files,
            chars,
            sourceId,
            pathPrefix,
            alreadyLoaded: false,
          };
        } catch (err) {
          if (id) emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
          throw err;   // serviceInterrupt catch → {error} reply → "Error: …" in the REPL
        }
      },
    },
  };
}
