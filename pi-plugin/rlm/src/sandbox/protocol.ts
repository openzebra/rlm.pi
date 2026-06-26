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
  readonly type: "llm_reply";
  readonly rid: string;
  readonly response?: string;
  readonly responses?: readonly string[];
  readonly answers?: readonly AskAnswer[];
  readonly error?: string;
}

export type ParentMessage = WorkerRequest | LlmReply;

export interface ProposedEdit {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export interface ProposedDiffEdit {
  readonly diff: string;
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
  diffs?: ProposedDiffEdit[];
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
  | "advance_phase"
  | "ask_user_question"
  | "todo";

export interface AskOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

export interface AskQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect?: boolean;
  readonly options: readonly AskOption[];
}

export interface AskAnswer {
  readonly question: string;
  readonly selected: readonly string[];
  readonly custom?: string;
}

export interface AskUserQuestionReply {
  readonly answers: readonly AskAnswer[];
}

interface InterruptBase {
  readonly rid: string;
  readonly depth: number;
}

interface PromptInterrupt extends InterruptBase {
  readonly type: "llm_query" | "rlm_query";
  readonly prompt?: string;
  readonly model?: string | null;
}

interface BatchedPromptInterrupt extends InterruptBase {
  readonly type: "llm_query_batched" | "rlm_query_batched";
  readonly prompts?: readonly string[];
  readonly model?: string | null;
}

interface AdvancePhaseInterrupt extends InterruptBase {
  readonly type: "advance_phase";
  readonly phase?: string;
  readonly summary?: string;
}

export interface AskUserQuestionInterrupt extends InterruptBase {
  readonly type: "ask_user_question";
  readonly questions: readonly AskQuestion[];
}

export interface TodoInterrupt extends InterruptBase {
  readonly type: "todo";
  readonly action: "create" | "update" | "list" | "get" | "delete" | "clear";
  readonly id?: number;
  readonly subject?: string;
  readonly description?: string;
  readonly status?: "pending" | "in_progress" | "completed" | "deleted";
  readonly activeForm?: string;
  readonly blockedBy?: readonly number[];
  readonly addBlockedBy?: readonly number[];
  readonly removeBlockedBy?: readonly number[];
  readonly owner?: string;
  readonly filterStatus?: string;
  readonly includeDeleted?: boolean;
}

/** A mid-exec sub-LLM/tool request from the worker. */
export type WorkerInterrupt =
  | PromptInterrupt
  | BatchedPromptInterrupt
  | AdvancePhaseInterrupt
  | AskUserQuestionInterrupt
  | TodoInterrupt;

export type WorkerMessage = WorkerResponse | WorkerInterrupt;

export const INTERRUPT_KINDS = new Set<InterruptKind>([
  "llm_query",
  "llm_query_batched",
  "rlm_query",
  "rlm_query_batched",
  "advance_phase",
  "ask_user_question",
  "todo",
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
  diffs: ProposedDiffEdit[];
  raised: boolean;
  executionTimeMs: number;
}
