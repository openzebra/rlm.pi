/**
 * Wire protocol for the RLM Python sandbox.
 *
 * Newline-delimited JSON over the worker's stdin/stdout — no sockets, no HTTP.
 * Parent -> worker: requests (exec/load_context/bootstrap/shutdown) and llm replies.
 * Worker -> parent: request responses and mid-exec sub-LLM interrupts.
 */

/** Requests the parent sends to the worker. */
export type WorkerRequest =
  | { id: string; type: "exec"; code: string }
  | { id: string; type: "load_context"; payload: unknown; index?: number }
  | { id: string; type: "bootstrap"; code: string }
  | { id: string; type: "shutdown" };

/** Reply the parent sends to satisfy a sub-LLM interrupt. */
export interface LlmReply {
  type: "llm_reply";
  rid: string;
  response?: string;
  responses?: string[];
  error?: string;
}

export type ParentMessage = WorkerRequest | LlmReply;

/** A normal response to a request (keyed by the request `id`). */
export interface WorkerResponse {
  id: string;
  ok: boolean;
  error?: string;
  // exec result fields:
  stdout?: string;
  stderr?: string;
  final_answer?: string | null;
  execution_time?: number;
  locals_keys?: string[];
  // load_context:
  index?: number;
}

/** Kinds of sub-LLM interrupt the worker can raise mid-exec. */
export type InterruptKind = "llm_query" | "llm_query_batched" | "rlm_query" | "rlm_query_batched";

/** A mid-exec sub-LLM request from the worker. */
export interface WorkerInterrupt {
  type: InterruptKind;
  rid: string;
  depth: number;
  prompt?: string;
  prompts?: string[];
  model?: string | null;
}

export type WorkerMessage = WorkerResponse | WorkerInterrupt;

const INTERRUPT_KINDS = new Set<string>([
  "llm_query",
  "llm_query_batched",
  "rlm_query",
  "rlm_query_batched",
]);

export function isInterrupt(msg: WorkerMessage): msg is WorkerInterrupt {
  return INTERRUPT_KINDS.has((msg as WorkerInterrupt).type);
}

/** Result of a single `repl` block execution, surfaced to the engine/tool. */
export interface ReplResult {
  stdout: string;
  stderr: string;
  finalAnswer: string | null;
  executionTimeMs: number;
  localsKeys: string[];
}
