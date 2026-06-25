/**
 * Wire protocol for the RLM Python sandbox.
 *
 * Newline-delimited JSON over the worker's stdin/stdout — no sockets, no HTTP.
 * Parent -> worker: requests (exec/load_context/shutdown) and llm replies.
 * Worker -> parent: request responses and mid-exec sub-LLM interrupts.
 */

/** Requests the parent sends to the worker. */
export type WorkerRequest =
  | { id: string; type: "exec"; code: string }
  | { id: string; type: "load_context"; path: string; index?: number; json: boolean }
  | { id: string; type: "snapshot"; path: string; nonce: string }
  | { id: string; type: "restore"; path: string; nonce: string }
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

export interface ProposedEdit {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/** A normal response to a request (keyed by the request `id`). */
export interface WorkerResponse {
  id: string;
  ok: boolean;
  error?: string;
  // exec result fields:
  stdout?: string;
  stderr?: string;
  final_answer?: string | null;
  answer_content?: string;
  edits?: ProposedEdit[];
  raised?: boolean;
  execution_time?: number;
  // load_context:
  index?: number;
  // snapshot/restore:
  skipped?: string[];
  restored?: string[];
}

/** Kinds of sub-LLM interrupt the worker can raise mid-exec. */
export type InterruptKind =
  | "llm_query"
  | "llm_query_batched"
  | "rlm_query"
  | "rlm_query_batched"
  | "read_file"
  | "grep"
  | "find"
  | "propose_edit";

/** A mid-exec sub-LLM/tool request from the worker. */
export interface WorkerInterrupt {
  type: InterruptKind;
  rid: string;
  depth: number;
  prompt?: string;
  prompts?: string[];
  model?: string | null;
  path?: string;
  start?: number | null;
  end?: number | null;
  pattern?: string;
  glob?: string | null;
  maxMatches?: number | null;
  old?: string;
  new?: string;
  existingEdits?: ProposedEdit[];
}

export type WorkerMessage = WorkerResponse | WorkerInterrupt;

export const INTERRUPT_KINDS = new Set<InterruptKind>([
  "llm_query",
  "llm_query_batched",
  "rlm_query",
  "rlm_query_batched",
  "read_file",
  "grep",
  "find",
  "propose_edit",
]);

export function isInterrupt(msg: WorkerMessage): msg is WorkerInterrupt {
  return INTERRUPT_KINDS.has((msg as WorkerInterrupt).type);
}

/** Result of a single `repl` block execution, surfaced to the engine/tool. */
export interface ReplResult {
  stdout: string;
  stderr: string;
  finalAnswer: string | null;
  answerContent: string;
  edits: ProposedEdit[];
  raised: boolean;
  executionTimeMs: number;
}
