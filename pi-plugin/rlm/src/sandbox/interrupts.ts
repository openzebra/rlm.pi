/**
 * The interrupt surface: what the worker can ask the host for mid-exec, and how each request is
 * turned into a reply frame.
 *
 * Canonical api_v5 kinds only: llm_query | llm_batch | rlm_query | rlm_batch | await | finish | add_context.
 *
 * Wire reply shapes the Python worker reduces:
 *   - single:  { response: string }  or { error }
 *   - batch:   { responses: string[] } or { error }
 *
 * Host handlers may return either:
 *   - plain string / string[] (tests, sync stubs)
 *   - SpawnResult { task_id } (createSubcallHandlers) — this layer awaits to final content
 */

import type { WorkerInterrupt } from "./protocol.ts";
import { writeContextTempFile } from "./context-file.ts";
import { errorMessage, formatError } from "../util/errors.ts";

/** Result of a host-side pack requested by `add_context`. */
export interface AddContextResult {
  readonly payload: unknown;
  readonly files?: number;
  readonly chars: number;
  readonly sourceId: string;
  readonly pathPrefix: string;
  readonly alreadyLoaded?: boolean;
  readonly documents?: number;
  readonly converted?: number;
  readonly skipped?: readonly { readonly path: string; readonly reason: string }[];
}

export interface SubcallOpts {
  readonly detached: boolean;
  /** Path prefixes for rlm_query / rlm_batch child context. */
  readonly paths?: readonly string[];
}

/** Handlers the bridge installs — canonical names only. */
export interface SubLlmHandlers {
  llmQuery(prompt: string, depth: number, opts: SubcallOpts): Promise<unknown>;
  llmBatch(prompts: readonly string[], depth: number, opts: SubcallOpts): Promise<unknown>;
  rlmQuery(task: string, depth: number, opts: SubcallOpts): Promise<unknown>;
  rlmBatch(tasks: readonly string[], depth: number, opts: SubcallOpts): Promise<unknown>;
  awaitTask(
    taskId: string | undefined,
    taskIds: readonly string[] | undefined,
    timeoutS: number | undefined,
    depth: number,
    opts: SubcallOpts,
  ): Promise<unknown>;
  finishTask(summary: string, depth: number, opts: SubcallOpts): Promise<unknown>;
  addContext(source: string, depth: number): Promise<AddContextResult>;
  /** v5: the `[ledger]` claims table for the sandbox's `list_claims()` REPL call. */
  ledgerClaims(): Promise<string>;
  /** v5: durable memory surface for the sandbox's `memory.query/add/stats` object. */
  memoryOp(
    op: "query" | "add" | "stats",
    args: { readonly query?: string; readonly k?: number; readonly content?: string; readonly paths?: readonly string[]; readonly tags?: readonly string[] },
    depth: number,
  ): Promise<string>;
}

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

const UNCONFIGURED = formatError("sub-LLM bridge not configured");

const rejectBatch = async (items: readonly string[]): Promise<readonly string[]> =>
  Object.freeze(items.map(() => UNCONFIGURED));

export const REJECT: SubLlmHandlers = Object.freeze({
  llmQuery: async () => UNCONFIGURED,
  llmBatch: rejectBatch,
  rlmQuery: async () => UNCONFIGURED,
  rlmBatch: rejectBatch,
  awaitTask: async () => UNCONFIGURED,
  finishTask: async () => UNCONFIGURED,
  addContext: async () => {
    throw new Error("add_context not configured");
  },
  ledgerClaims: async () => UNCONFIGURED,
  memoryOp: async () => UNCONFIGURED,
});

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
  documents?: number;
  converted?: number;
  skipped?: readonly { readonly path: string; readonly reason: string }[];
  error?: string;
}

const RLM_PATH_TYPES = new Set(["rlm_query", "rlm_batch"]);

/** Narrow unknown to SpawnResult-shaped object from createSubcallHandlers. */
function isSpawnResult(
  value: unknown,
): value is {
  readonly ok: boolean;
  readonly task_id: string | null;
  readonly kind: string;
  readonly error?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.ok === "boolean" &&
    (typeof o.task_id === "string" || o.task_id === null) &&
    typeof o.kind === "string" &&
    typeof o.status === "string"
  );
}

/** Narrow unknown to AwaitResult-shaped object. */
function isAwaitResult(
  value: unknown,
): value is {
  readonly ok: boolean;
  readonly result?: string;
  readonly results?: readonly string[];
  readonly error?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.ok === "boolean" && typeof o.task_id === "string" && typeof o.status === "string";
}

/**
 * Resolve a handler return value to a single `response` string for the worker.
 * Accepts plain string stubs OR SpawnResult (awaits to completion).
 */
async function resolveSingle(
  h: SubLlmHandlers,
  raw: unknown,
  depth: number,
  opts: SubcallOpts,
): Promise<ReplyBody> {
  if (typeof raw === "string") {
    return { response: raw };
  }
  if (isSpawnResult(raw)) {
    if (!raw.ok || raw.task_id === null) {
      const err = raw.error ?? "spawn failed";
      return { error: err, response: formatError(err) };
    }
    const collected = await h.awaitTask(raw.task_id, undefined, undefined, depth, opts);
    if (typeof collected === "string") {
      return { response: collected };
    }
    if (isAwaitResult(collected)) {
      if (!collected.ok && collected.error !== undefined) {
        return { error: collected.error, response: formatError(collected.error) };
      }
      return { response: collected.result ?? "" };
    }
    return { response: String(collected ?? "") };
  }
  // Unexpected shape — surface as text rather than crash the worker.
  return { response: String(raw ?? "") };
}

/**
 * Resolve a handler return value to `responses: string[]` for the worker batch reducer.
 */
async function resolveBatch(
  h: SubLlmHandlers,
  raw: unknown,
  expectedN: number,
  depth: number,
  opts: SubcallOpts,
): Promise<ReplyBody> {
  if (Array.isArray(raw)) {
    const responses = raw.map((x) => (typeof x === "string" ? x : String(x)));
    return { responses };
  }
  if (isSpawnResult(raw)) {
    if (!raw.ok || raw.task_id === null) {
      const err = raw.error ?? "spawn failed";
      const msg = formatError(err);
      return {
        error: err,
        responses: Array.from({ length: Math.max(1, expectedN) }, () => msg),
      };
    }
    const collected = await h.awaitTask(raw.task_id, undefined, undefined, depth, opts);
    if (Array.isArray(collected)) {
      return { responses: collected.map(String) };
    }
    if (isAwaitResult(collected)) {
      if (collected.results !== undefined) {
        return { responses: [...collected.results] };
      }
      if (!collected.ok && collected.error !== undefined) {
        const msg = formatError(collected.error);
        return {
          error: collected.error,
          responses: Array.from({ length: Math.max(1, expectedN) }, () => msg),
        };
      }
      if (collected.result !== undefined) {
        return { responses: [collected.result] };
      }
    }
    return {
      error: "malformed batch await result",
      responses: Array.from({ length: Math.max(1, expectedN) }, () =>
        formatError("malformed batch await result"),
      ),
    };
  }
  if (typeof raw === "string") {
    return { responses: [raw] };
  }
  return {
    error: "malformed batch handler result",
    responses: Array.from({ length: Math.max(1, expectedN) }, () =>
      formatError("malformed batch handler result"),
    ),
  };
}

/**
 * Service one interrupt and hand the reply body to `reply`.
 * Errors are replied, never thrown.
 */
export async function serviceInterrupt(
  msg: WorkerInterrupt,
  h: SubLlmHandlers,
  reply: (rid: string, body: ReplyBody) => void,
): Promise<void> {
  const d = msg.depth;
  const paths =
    "paths" in msg && RLM_PATH_TYPES.has(msg.type)
      ? toStringArray(msg.paths)
      : undefined;
  const opts: SubcallOpts = Object.freeze({
    detached: msg.detached === true,
    paths,
  });

  try {
    switch (msg.type) {
      case "llm_query": {
        const raw = await h.llmQuery(msg.prompt ?? "", d, opts);
        reply(msg.rid, await resolveSingle(h, raw, d, opts));
        return;
      }
      case "rlm_query": {
        const raw = await h.rlmQuery(msg.prompt ?? "", d, opts);
        reply(msg.rid, await resolveSingle(h, raw, d, opts));
        return;
      }
      case "llm_batch": {
        const prompts = msg.prompts ?? [];
        const raw = await h.llmBatch(prompts, d, opts);
        reply(msg.rid, await resolveBatch(h, raw, prompts.length, d, opts));
        return;
      }
      case "rlm_batch": {
        const tasks = msg.tasks ?? msg.prompts ?? [];
        const raw = await h.rlmBatch(tasks, d, opts);
        reply(msg.rid, await resolveBatch(h, raw, tasks.length, d, opts));
        return;
      }
      case "await": {
        // Host-level await (orchestrator tools). Worker uses Task + await_task in-process.
        const result = await h.awaitTask(
          msg.task_id,
          msg.task_ids,
          msg.timeout_s,
          d,
          opts,
        );
        if (typeof result === "string") {
          reply(msg.rid, { response: result });
          return;
        }
        if (isAwaitResult(result)) {
          if (result.results !== undefined) {
            reply(msg.rid, { responses: [...result.results] });
            return;
          }
          reply(msg.rid, {
            response: result.result ?? "",
            error: result.ok ? undefined : result.error,
          });
          return;
        }
        reply(msg.rid, { response: String(result ?? "") });
        return;
      }
      case "finish": {
        const result = await h.finishTask(msg.summary ?? "", d, opts);
        // finish is not reduced by the worker as content — stringify is fine
        reply(msg.rid, {
          response:
            typeof result === "string"
              ? result
              : JSON.stringify(result ?? { ok: true, finished: true }),
        });
        return;
      }
      case "add_context": {
        const lib = await h.addContext(msg.source ?? "", d);
        if (lib.alreadyLoaded) {
          reply(msg.rid, {
            already_loaded: true,
            files: 0,
            chars: lib.chars,
            source_id: lib.sourceId,
            path_prefix: lib.pathPrefix,
            documents: lib.documents ?? 0,
            converted: lib.converted ?? 0,
            skipped: lib.skipped,
          });
          return;
        }
        const { path, json: isJson } = await writeContextTempFile(lib.payload);
        reply(msg.rid, {
          path,
          json: isJson,
          files: lib.files,
          chars: lib.chars,
          source_id: lib.sourceId,
          path_prefix: lib.pathPrefix,
          documents: lib.documents ?? 0,
          converted: lib.converted ?? 0,
          skipped: lib.skipped,
        });
        return;
      }
      case "ledger_claims": {
        const table = await h.ledgerClaims();
        reply(msg.rid, { response: table });
        return;
      }
      case "memory": {
        const out = await h.memoryOp(
          msg.op,
          { query: msg.query, k: msg.k, content: msg.content, paths: msg.paths, tags: msg.tags },
          d,
        );
        reply(msg.rid, { response: out });
        return;
      }
      default: {
        const _exhaustive: never = msg;
        reply((_exhaustive as WorkerInterrupt).rid, {
          error: "unknown interrupt type",
        });
      }
    }
  } catch (err: unknown) {
    reply(msg.rid, { error: errorMessage(err) });
  }
}
