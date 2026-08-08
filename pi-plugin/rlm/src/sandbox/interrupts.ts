/**
 * The interrupt surface: what the worker can ask the host for mid-exec, and how each request is
 * turned into a reply frame.
 *
 * Split from sandbox.ts, which owns the subprocess and the JSONL pump. Adding a sandbox function
 * touches this file and worker.py; the transport underneath does not change.
 */

import type { WorkerInterrupt } from "./protocol.ts";
import { writeContextTempFile } from "./context-file.ts";
import { errorMessage, formatError } from "../util/errors.ts";

/** Result of a host-side library pack requested by `load_library`. */
export interface LibraryLoadResult {
  readonly payload: unknown;     // always ContextFile[] under lib/<id>/
  readonly files?: number;
  readonly chars: number;
  readonly sourceId: string;
  readonly pathPrefix: string;
  /** Host already has this library — no pack, empty payload. */
  readonly alreadyLoaded?: boolean;
}

/**
 * Per-interrupt routing context for the sub-LLM handlers.
 *
 * Only the four sub-call kinds can be spawned, so only they carry it; load_library is
 * always synchronous within one exec.
 */
export interface SubcallOpts {
  /** Started via `spawn()` — route to session-scoped state, not the current invocation. */
  readonly detached: boolean;
  /**
   * `rlm_query(paths=[…])` — path prefixes narrowing the child's inherited context.
   * Absent on every other path; `llm_query` never carries it.
   */
  readonly paths?: readonly string[];
}

/** Handlers the bridge installs to service sub-LLM interrupts. Return the reply payload. */
export interface SubLlmHandlers {
  llmQuery(prompt: string, model: string | null, depth: number, opts: SubcallOpts): Promise<string>;
  llmQueryBatched(prompts: readonly string[], model: string | null, depth: number, opts: SubcallOpts): Promise<string[]>;
  rlmQuery(prompt: string, model: string | null, depth: number, opts: SubcallOpts): Promise<string>;
  rlmQueryBatched(prompts: readonly string[], model: string | null, depth: number, opts: SubcallOpts): Promise<string[]>;
  loadLibrary(source: string, depth: number): Promise<LibraryLoadResult>;
}

/** Narrow an unknown JSON value to a frozen string array. Non-strings and blanks are dropped. */
function toStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = new Array<string>(value.length);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item === "string" && item.trim() !== "") out[n++] = item;
  }
  out.length = n;
  return n > 0 ? Object.freeze(out) : undefined;
}

/** Default handlers — every sandbox function refuses until a bridge installs a real one. */
export const REJECT: SubLlmHandlers = {
  llmQuery: async () => formatError("sub-LLM bridge not configured"),
  llmQueryBatched: async (p) => p.map(() => formatError("sub-LLM bridge not configured")),
  rlmQuery: async () => formatError("sub-LLM bridge not configured"),
  rlmQueryBatched: async (p) => p.map(() => formatError("sub-LLM bridge not configured")),
  loadLibrary: async () => { throw new Error("load_library not configured"); },
};

/** Body of a reply frame — the union of every handler's payload shape. */
export interface ReplyBody {
  response?: string;
  responses?: string[];
  path?: string;
  json?: boolean;
  files?: number;
  chars?: number;
  source_id?: string;
  path_prefix?: string;
  already_loaded?: boolean;
  error?: string;
}

/**
 * Service one interrupt and hand the reply body to `reply`.
 *
 * Errors are replied, never thrown: the caller invokes this from the stdio pump, where a
 * rejection would surface as an unhandled promise and leave the worker parked forever.
 */
export async function serviceInterrupt(
  msg: WorkerInterrupt,
  h: SubLlmHandlers,
  reply: (rid: string, body: ReplyBody) => void,
): Promise<void> {
  const d = msg.depth;
  const opts: SubcallOpts = Object.freeze({
    detached: msg.detached === true,
    // Only the recursive kinds carry a context slice; the value crossed JSON, so guard it.
    paths: msg.type === "rlm_query" || msg.type === "rlm_query_batched"
      ? toStringArray(msg.paths)
      : undefined,
  });
  try {
    if (msg.type === "llm_query") {
      const response = await h.llmQuery(msg.prompt ?? "", msg.model ?? null, d, opts);
      reply(msg.rid, { response });
    } else if (msg.type === "rlm_query") {
      const response = await h.rlmQuery(msg.prompt ?? "", msg.model ?? null, d, opts);
      reply(msg.rid, { response });
    } else if (msg.type === "llm_query_batched") {
      const responses = await h.llmQueryBatched(msg.prompts ?? [], msg.model ?? null, d, opts);
      reply(msg.rid, { responses });
    } else if (msg.type === "rlm_query_batched") {
      const responses = await h.rlmQueryBatched(msg.prompts ?? [], msg.model ?? null, d, opts);
      reply(msg.rid, { responses });
    } else if (msg.type === "load_library") {
      const lib = await h.loadLibrary(msg.source ?? "", d);
      if (lib.alreadyLoaded) {
        // No temp file — worker short-circuits on already_loaded.
        reply(msg.rid, {
          already_loaded: true,
          files: 0,
          chars: lib.chars,
          source_id: lib.sourceId,
          path_prefix: lib.pathPrefix,
        });
      } else {
        const { path, json: isJson } = await writeContextTempFile(lib.payload);
        // Worker reads then unlinks (worker._load_library). Host must not unlink here —
        // if the worker is SIGKILLed before os.remove, the temp file leaks in tmpdir (acceptable).
        reply(msg.rid, {
          path,
          json: isJson,
          files: lib.files,
          chars: lib.chars,
          source_id: lib.sourceId,
          path_prefix: lib.pathPrefix,
        });
      }
    }
  } catch (err) {
    reply(msg.rid, { error: errorMessage(err) });
  }
}
