/** Shared configuration + runtime types for the RLM engine and native mode. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface Sampling {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
}

export interface RlmConfig {
  /** Max recursion depth. depth >= maxDepth ⇒ rlm_query falls back to a plain llm_query. */
  maxDepth: number;
  /** Max turns before the engine/native loop must finalize. */
  maxIterations: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  execTimeoutS: number;
  /** Parent-side watchdog per sandbox request (ms). */
  requestTimeoutMs: number;
  /** Concurrency pool for *_batched sub-calls. */
  maxConcurrentSubcalls: number;
  /** Reject sub-LLM prompts larger than this many chars. */
  maxPromptChars: number;
  /** Append the orchestrator addendum to the system prompt. */
  orchestrator: boolean;
  /** Summarize the trajectory when it grows past the threshold (keeps the root window small). */
  compaction: boolean;
  /** Compact when estimated history tokens reach this fraction of the model's context window. */
  compactionThresholdPct: number;
  /** Python executable used to launch the sandbox worker. */
  python: string;
  /** Sampling for sub-LLM (worker) calls. */
  subSampling: Sampling;
}

/** Input to a (headless) RLM run. */
export interface RlmInput {
  /** The question for the root model (folded into the metadata prompt). */
  rootPrompt: string;
  /** The (possibly huge) context loaded into the sandbox REPL. */
  context: unknown;
  /** Recursion depth; 0 = top-level root. */
  depth: number;
  /** AgentTree node to attach this run's node under (set when recursing). */
  parentNodeId?: string;
}

/** Result of a completed RLM run (headless or native). */
export interface RlmResult {
  answer: string;
  iterations: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** A function that runs an RLM to completion — used to wire recursion (rlm_query). */
export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
