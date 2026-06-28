/**
 * Wire protocol for the RLM Python sandbox.
 *
 * Newline-delimited JSON over the worker's stdin/stdout — no sockets, no HTTP.
 * Parent -> worker: requests (exec/load_context/shutdown) and llm replies.
 * Worker -> parent: request responses and mid-exec sub-LLM interrupts.
 */

/** Requests the parent sends to the worker. */
export type WorkerRequest =
  | { readonly id: string; readonly type: "exec"; readonly code: string }
  | { readonly id: string; readonly type: "load_context"; readonly path: string; readonly index?: number; readonly json: boolean }
  | { readonly id: string; readonly type: "snapshot"; readonly path: string; readonly nonce: string }
  | { readonly id: string; readonly type: "restore"; readonly path: string; readonly nonce: string }
  | { readonly id: string; readonly type: "shutdown" };

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
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  // exec result fields:
  readonly stdout?: string;
  readonly stderr?: string;
  readonly final_answer?: string | null;
  readonly answer_content?: string;
  readonly edits?: readonly ProposedEdit[];
  readonly diffs?: readonly ProposedDiffEdit[];
  readonly raised?: boolean;
  readonly execution_time?: number;
  // user-created variable names after this exec (filters builtins/context) — Metadata(stdout) for history orientation
  readonly var_names?: readonly string[];
  // load_context:
  readonly index?: number;
  // snapshot/restore:
  readonly skipped?: readonly string[];
  readonly restored?: readonly string[];
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

export const INTERRUPT_KINDS = Object.freeze(new Set<InterruptKind>([
  "llm_query",
  "llm_query_batched",
  "rlm_query",
  "rlm_query_batched",
  "advance_phase",
  "ask_user_question",
  "todo",
]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return isRecord(value) && typeof value.id === "string" && typeof value.ok === "boolean";
}

export function isInterrupt(msg: unknown): msg is WorkerInterrupt {
  return isRecord(msg)
    && typeof msg.type === "string"
    && INTERRUPT_KINDS.has(msg.type as InterruptKind)
    && typeof msg.rid === "string"
    && typeof msg.depth === "number";
}

export function isWorkerMessage(msg: unknown): msg is WorkerMessage {
  return isWorkerResponse(msg) || isInterrupt(msg);
}

/** Result of a single `repl` block execution, surfaced to the engine/tool. */
export interface ReplResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly finalAnswer: string | null;
  readonly answerContent: string;
  readonly edits: readonly ProposedEdit[];
  readonly diffs: readonly ProposedDiffEdit[];
  readonly raised: boolean;
  readonly executionTimeMs: number;
  /** User-created variable names after this exec (builtins/context filtered out). */
  readonly varNames: readonly string[];
}
