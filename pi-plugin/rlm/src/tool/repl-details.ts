/**
 * ReplDetails — structured payload for the repl() tool's AgentToolResult<T>.
 *
 * Mirrors RlmDetails but scoped to a single code execution. Sub-calls (llm_query,
 * rlm_query, todo, ask_user_question) triggered during sandbox execution are
 * accumulated into the subcalls array for tree rendering.
 */

import type { RlmSubcall } from "./rlm-details.ts";

export interface ReplDetails {
  status: "running" | "done" | "error";
  /** stdout from the Python execution. */
  output: string;
  /** stderr from the Python execution. */
  stderr: string;
  /** Wall-clock execution time in milliseconds. */
  executionTimeMs: number;
  /** Sub-calls triggered during this execution (llm_query, rlm_query, todo, etc.). */
  subcalls: RlmSubcall[];
  /** Running totals for this repl() call (cost + tokens from sub-LLM calls). */
  totals: { costUsd: number; tokens: number };
}
