/** Shared configuration + runtime types for the RLM engine. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";

export interface Sampling {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: ThinkingLevel;
}

export interface RlmConfig {
  /** Persistent editor-routing mode; when enabled, plain interactive prompts use RLM. */
  readonly enabled: boolean;
  /** Max recursion depth. depth >= maxDepth ⇒ rlm_query falls back to a plain llm_query. */
  readonly maxDepth: number;
  /** Max turns before the engine must finalize. */
  readonly maxIterations: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  readonly execTimeoutS: number;
  /** Parent-side watchdog per sandbox request (ms). */
  readonly requestTimeoutMs: number;
  /** Concurrency pool for *_batched sub-calls. */
  readonly maxConcurrentSubcalls: number;
  /** Concurrent recursive child engines admitted per depth. Lower than maxConcurrentSubcalls:
   *  each child is a Python subprocess holding its own copy of the inherited context. */
  readonly maxConcurrentChildren: number;
  /** Reject sub-LLM prompts larger than this many chars. */
  readonly maxPromptChars: number;
  /** Max USD spend across the whole tree before the engine stops (undefined = no cap). */
  readonly maxBudgetUsd?: number;
  /** Max wall-clock ms across the whole tree before the engine stops (undefined = no cap). */
  readonly maxTimeoutMs?: number;
  /** Max total input+output tokens across the whole tree before the engine stops (undefined = no cap). */
  readonly maxTokens?: number;
  /** Max consecutive error turns before the engine stops (undefined = no cap). */
  readonly maxErrors?: number;
  /** Append the orchestrator addendum to the system prompt. */
  readonly orchestrator: boolean;
  /** Summarize the trajectory when it grows past the threshold (keeps the root window small). */
  readonly compaction: boolean;
  /** Compact when estimated history tokens reach this fraction of the model's context window. */
  readonly compactionThresholdPct: number;
  /** Python executable used to launch the sandbox worker. */
  readonly python: string;
  /** Worker startup wait before treating sandbox init as failed (ms). */
  readonly sandboxInitTimeoutMs: number;
  /** Allow ask_user_question() calls from the root REPL. */
  readonly askUserQuestion: boolean;
  /** Enable the load_library() REPL scaffold (external dirs/files/git repos as extra context slots). */
  readonly libraryLoader: boolean;
  /** ThinkingLevel for the root smart model (set via /rlm-config). */
  readonly smartReasoning?: ThinkingLevel;
  /** Output token cap + temperature for the root smart model per turn.
   *  Keeps each turn short so the next turn's input stays manageable.
   *  `reasoning` is read from `smartReasoning` if omitted here. */
  readonly rootSampling?: Readonly<Sampling>;
  /** System prompt injected into every llm_query / llm_query_batched sub-call.
   *  Instructs the worker model to respond concisely.
   *  undefined = no system prompt (raw completion). */
  readonly subSystemPrompt?: string;
  /** Sampling for sub-LLM (worker) calls. */
  readonly subSampling: Readonly<Sampling>;
}

/** Input to a (headless) RLM run. */
export interface RlmInput {
  /** The question for the root model (folded into the metadata prompt). */
  readonly rootPrompt: string;
  /** The (possibly huge) context loaded into the sandbox REPL. */
  readonly context: unknown;
  /** Recursion depth; 0 = top-level root. */
  readonly depth: number;
  /** AgentTree node to attach this run's node under (set when recursing). */
  readonly parentNodeId?: string;
  /** "provider/id" — overrides the root model for this run (set by recursive rlm_query). */
  readonly modelOverride?: string;
  /** Remaining budget for this subtree (set by parent from its LimitGuard). */
  readonly remainingBudgetUsd?: number;
  /** Remaining timeout for this subtree (set by parent from its LimitGuard). */
  readonly remainingTimeoutMs?: number;
}

/** Result of a completed RLM run. */
export interface RlmResult {
  readonly answer: string;
  readonly iterations: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

/** A function that runs an RLM to completion — used to wire recursion (rlm_query). */
export interface InteractiveDeps {
  /** Called when the sandbox issues ask_user_question; undefined = feature disabled. */
  readonly onAskUserQuestion?: (questions: readonly AskQuestion[]) => Promise<AskAnswer[]>;
}

export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
