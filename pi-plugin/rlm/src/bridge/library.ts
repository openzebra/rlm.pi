/**
 * Shared load_library handler for headless engine and native repl() mode.
 *
 * Host packs the source via resolveLibrarySource (namespaced under lib/<id>/),
 * assigns a resume-sidecar index, and returns the payload for the worker to
 * append into the single `context` list.
 *
 * Idempotency is host-side: re-loading a source that was already packed does
 * not consume an index, write a sidecar, or re-clone/pack. That keeps resume
 * trails free of duplicate library slots.
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
  /** First resume-sidecar index (slot 0 = repo). Resume passes 1 + max restored. */
  readonly startIndex: number;
  /**
   * Prefixes already present in context (e.g. restored from sidecars).
   * Seeded so re-load after resume is still a no-op without re-packing.
   */
  readonly loadedPrefixes?: readonly string[];
  /** Post-load hook — the engine writes the resume sidecar here; native mode omits it. */
  readonly onLoaded?: (index: number, payload: unknown) => void | Promise<void>;
}

export interface LibraryHandlerBundle {
  readonly handlers: Pick<SubLlmHandlers, "loadLibrary">;
  /** Reset the sidecar index counter (call when the sandbox is discarded and will re-spawn). */
  readonly reset: () => void;
  /** Prefixes loaded in this sandbox lifetime (for tests). */
  readonly loadedPrefixes: () => ReadonlySet<string>;
}

export function buildLibraryHandler(opts: LibraryBridgeOpts): LibraryHandlerBundle {
  let nextIndex = opts.startIndex;
  /** Prefixes already loaded in this sandbox — mirrors the worker's context state. */
  const loaded = new Set<string>(opts.loadedPrefixes ?? []);
  return {
    reset: () => {
      nextIndex = opts.startIndex;
      loaded.clear();
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
            // No index consumed, no sidecar written — resume stays consistent.
            return {
              payload: Object.freeze([]),
              index: -1,
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
              index: -1,
              files: 0,
              chars: 0,
              sourceId,
              pathPrefix,
              alreadyLoaded: true,
            };
          }

          // Increment only after a successful sidecar write (or when no hook is set).
          const index = nextIndex;
          if (opts.onLoaded) {
            await opts.onLoaded(index, payload);
          }
          nextIndex = index + 1;
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
            index,
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
