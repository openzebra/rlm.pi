/**
 * ReplDetails — structured payload for the repl() tool's AgentToolResult<T>.
 *
 * Mirrors RlmDetails but scoped to a single code execution. Sub-calls (llm_query,
 * rlm_query, ask_user_question) triggered during sandbox execution are
 * accumulated into the subcalls array for tree rendering.
 */

import type { RlmSubcall } from "./rlm-details.ts";

export interface ReplDetails {
  readonly status: "running" | "done" | "error";
  /** stdout from the Python execution. */
  readonly output: string;
  /** stderr from the Python execution. */
  readonly stderr: string;
  /** Wall-clock execution time in milliseconds. */
  readonly executionTimeMs: number;
  /** Sub-calls triggered during this execution (llm_query, rlm_query, etc.). */
  readonly subcalls: readonly RlmSubcall[];
  /** Running totals for this repl() call (cost + tokens from sub-LLM calls). */
  readonly totals: { readonly costUsd: number; readonly tokens: number };
  /** Final answer submitted through answer["ready"] without echoing it to the model. */
  readonly finalAnswer?: string;
  /** Detached spawn() sub-calls still running when this call returned. Absent when none. */
  readonly backgroundPending?: number;
  /** Advisory diagnostics — surfaced to the user, never a failure. */
  readonly warnings?: readonly string[];
}
