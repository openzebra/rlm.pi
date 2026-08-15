/**
 * Wire protocol for the RLM Python sandbox.
 *
 * Newline-delimited JSON over the worker's stdin/stdout — no sockets, no HTTP.
 * Parent -> worker: requests (exec/load_context/shutdown) and llm replies.
 * Worker -> parent: request responses and mid-exec sub-LLM interrupts.
 *
 * Canonical api_v5 kinds only — no legacy `*_query_batched` wire names.
 */

/** Requests the parent sends to the worker. */
export type WorkerRequest =
  | { readonly id: string; readonly type: "exec"; readonly code: string }
  | {
      readonly id: string;
      readonly type: "load_context";
      readonly path: string;
      readonly index?: number;
      readonly json: boolean;
    }
  | { readonly id: string; readonly type: "shutdown" };

/** Reply the parent sends to satisfy a sub-LLM interrupt. */
export interface LlmReply {
  readonly type: "llm_reply";
  readonly rid: string;
  readonly response?: string;
  readonly responses?: readonly string[];
  /** add_context reply: temp file with the packed payload (+ namespace metadata). */
  readonly path?: string;
  readonly json?: boolean;
  readonly files?: number;
  readonly chars?: number;
  readonly source_id?: string;
  readonly path_prefix?: string;
  /** Host-side idempotency: source already loaded — no path payload. */
  readonly already_loaded?: boolean;
  /** Document-type files in the payload (fresh + cache hits). */
  readonly documents?: number;
  /** Documents freshly converted this call (cache hits excluded). */
  readonly converted?: number;
  /** Paths skipped during packing (binary, no-converter, …). */
  readonly skipped?: readonly { readonly path: string; readonly reason: string }[];
  readonly error?: string;
}

export type ParentMessage = WorkerRequest | LlmReply;

/** A normal response to a request (keyed by the request `id`). */
export interface WorkerResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  // exec result fields:
  readonly stdout?: string;
  readonly stderr?: string;
  readonly final_answer?: string | null;
  readonly answer_content?: string;
  readonly raised?: boolean;
  readonly execution_time?: number;
  // user-created variable names after this exec
  readonly var_names?: readonly string[];
  /** Unsettled Task handles still in the worker (native pending-line / await-all). */
  readonly pending_tasks?: readonly PendingTaskInfo[];
  // load_context:
  readonly index?: number;
}

/** Canonical interrupt kinds (api_v5 + v5 ledger + memory). */
export type InterruptKind =
  | "llm_query"
  | "rlm_query"
  | "llm_batch"
  | "rlm_batch"
  | "await"
  | "finish"
  | "add_context"
  | "ledger_claims"
  | "memory";

interface InterruptBase {
  readonly rid: string;
  readonly depth: number;
  /**
   * Detached work may outlive the exec that issued it.
   */
  readonly detached?: boolean;
}

interface PromptInterrupt extends InterruptBase {
  readonly type: "llm_query" | "rlm_query";
  readonly prompt?: string;
  /** `rlm_query` only — path prefixes narrowing the child's inherited context. */
  readonly paths?: readonly string[];
}

interface BatchInterrupt extends InterruptBase {
  readonly type: "llm_batch" | "rlm_batch";
  readonly prompts?: readonly string[];
  readonly tasks?: readonly string[];
  readonly paths?: readonly string[];
}

interface AwaitInterrupt extends InterruptBase {
  readonly type: "await";
  readonly task_id?: string;
  readonly task_ids?: readonly string[];
  readonly timeout_s?: number;
}

interface FinishInterrupt extends InterruptBase {
  readonly type: "finish";
  readonly summary?: string;
}

export interface AddContextInterrupt extends InterruptBase {
  readonly type: "add_context";
  readonly source?: string;
}

/** v5: sandbox asks the host for the TaskLedger claims table (`list_claims()`). */
export interface LedgerClaimsInterrupt extends InterruptBase {
  readonly type: "ledger_claims";
}

/** v5: sandbox reaches the durable MemoryStore (`memory.query/add/stats`). */
export interface MemoryInterrupt extends InterruptBase {
  readonly type: "memory";
  readonly op: "query" | "add" | "stats";
  readonly query?: string;
  readonly k?: number;
  readonly content?: string;
  readonly paths?: readonly string[];
  readonly tags?: readonly string[];
}

/** A mid-exec sub-LLM/tool request from the worker. */
export type WorkerInterrupt =
  | PromptInterrupt
  | BatchInterrupt
  | AwaitInterrupt
  | FinishInterrupt
  | AddContextInterrupt
  | LedgerClaimsInterrupt
  | MemoryInterrupt;

export type WorkerMessage = WorkerResponse | WorkerInterrupt;

export const INTERRUPT_KINDS = Object.freeze(
  new Set<InterruptKind>([
    "llm_query",
    "rlm_query",
    "llm_batch",
    "rlm_batch",
    "await",
    "finish",
    "add_context",
    "ledger_claims",
    "memory",
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return isRecord(value) && typeof value.id === "string" && typeof value.ok === "boolean";
}

export function isInterrupt(msg: unknown): msg is WorkerInterrupt {
  return (
    isRecord(msg) &&
    typeof msg.type === "string" &&
    INTERRUPT_KINDS.has(msg.type as InterruptKind) &&
    typeof msg.rid === "string" &&
    typeof msg.depth === "number"
  );
}

export function isWorkerMessage(msg: unknown): msg is WorkerMessage {
  return isWorkerResponse(msg) || isInterrupt(msg);
}

/** Unsettled Task still in the worker, optionally bound to a REPL variable. */
export interface PendingTaskInfo {
  readonly var: string | null;
  readonly kind: string;
  readonly label: string;
}

const EMPTY_PENDING: readonly PendingTaskInfo[] = Object.freeze([]);

function isPendingTaskInfo(value: unknown): value is PendingTaskInfo {
  if (!isRecord(value)) return false;
  const bound = value["var"];
  return (typeof bound === "string" || bound === null)
    && typeof value["kind"] === "string"
    && typeof value["label"] === "string";
}

/** Narrow a worker `pending_tasks` payload; drop malformed entries. */
export function parsePendingTasks(value: unknown): readonly PendingTaskInfo[] {
  if (!Array.isArray(value)) return EMPTY_PENDING;
  const out = new Array<PendingTaskInfo>(value.length);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (isPendingTaskInfo(item)) {
      out[n] = item;
      n += 1;
    }
  }
  out.length = n;
  return n === 0 ? EMPTY_PENDING : Object.freeze(out);
}

/** Result of a single `repl` block execution, surfaced to the engine/tool. */
export interface ReplResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly finalAnswer: string | null;
  readonly answerContent: string;
  readonly raised: boolean;
  readonly executionTimeMs: number;
  /** User-created variable names after this exec (builtins/context filtered out). */
  readonly varNames: readonly string[];
  /** Unsettled Task handles still in the worker after this exec. */
  readonly pendingTasks: readonly PendingTaskInfo[];
}
