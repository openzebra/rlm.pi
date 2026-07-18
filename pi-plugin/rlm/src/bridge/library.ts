/**
 * Shared load_library handler for headless engine and native repl() mode.
 *
 * Host assigns context slot indices (slot 0 = repo); packs the source via
 * resolveLibrarySource; optional onLoaded writes resume sidecars.
 *
 * Late-bound deps (getCwd / getEmitter) keep a single handler closure correct
 * across native repl() calls — getOrCreate only installs handlers at spawn.
 */

import type { RlmEmitter } from "../tool/rlm-events.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import { resolveLibrarySource } from "../context/library-context.ts";
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
  /** First slot to assign (slot 0 is the repo context). Resume passes 1 + restored slots. */
  readonly startIndex: number;
  /** Post-load hook — the engine writes the resume sidecar here; native mode omits it. */
  readonly onLoaded?: (index: number, payload: unknown) => void | Promise<void>;
}

export interface LibraryHandlerBundle {
  readonly handlers: Pick<SubLlmHandlers, "loadLibrary">;
  /** Reset the slot counter (call when the sandbox is discarded and will re-spawn). */
  readonly reset: () => void;
}

export function buildLibraryHandler(opts: LibraryBridgeOpts): LibraryHandlerBundle {
  let nextIndex = opts.startIndex;
  return {
    reset: () => { nextIndex = opts.startIndex; },
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
          const resolved = await resolveLibrarySource(source, cwd, opts.signal);
          if (!resolved.ok) throw new Error(resolved.error);
          const index = nextIndex++;
          await opts.onLoaded?.(index, resolved.value.payload);
          if (id) emitter?.emitSubcallUpdated({
            id, status: "done",
            resultPreview: `context_${index}: ${resolved.value.files ?? 1} file(s), ${resolved.value.chars.toLocaleString()} chars`,
          });
          return {
            payload: resolved.value.payload,
            index,
            files: resolved.value.files,
            chars: resolved.value.chars,
          };
        } catch (err) {
          if (id) emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
          throw err;   // serviceInterrupt catch → {error} reply → "Error: …" in the REPL
        }
      },
    },
  };
}
