/** Shared configuration + runtime types for the RLM engine. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AskAnswer, AskQuestion, ProposedEdit } from "../sandbox/protocol.ts";
import type { ReconstructResult } from "../state/resume.ts";

export interface Sampling {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: ThinkingLevel;
}

type MutableSampling = { -readonly [Key in keyof Sampling]?: Sampling[Key] };

export interface RunLogConfig {
  /** Default: true — always-on, opt-out. */
  readonly enabled?: boolean;
  /** Default: ".rlm/runs". Directory under cwd for run artifacts. */
  readonly dir?: string;
  /** Default: true — whether to write sandbox.pkl snapshots. */
  readonly snapshot?: boolean;
  /** Default: 50 — prune oldest runs beyond this count on each new run. */
  readonly maxRuns?: number;
}

export interface RlmConfig {
  /** Persistent editor-routing mode; when enabled, plain interactive prompts use RLM. */
  enabled: boolean;
  /** Max recursion depth. depth >= maxDepth ⇒ rlm_query falls back to a plain llm_query. */
  maxDepth: number;
  /** Max turns before the engine must finalize. */
  maxIterations: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  execTimeoutS: number;
  /** Parent-side watchdog per sandbox request (ms). */
  requestTimeoutMs: number;
  /** Concurrency pool for *_batched sub-calls. */
  maxConcurrentSubcalls: number;
  /** Reject sub-LLM prompts larger than this many chars. */
  maxPromptChars: number;
  /** Max USD spend across the whole tree before the engine stops (undefined = no cap). */
  maxBudgetUsd?: number;
  /** Max wall-clock ms across the whole tree before the engine stops (undefined = no cap). */
  maxTimeoutMs?: number;
  /** Max total input+output tokens across the whole tree before the engine stops (undefined = no cap). */
  maxTokens?: number;
  /** Max consecutive error turns before the engine stops (undefined = no cap). */
  maxErrors?: number;
  /** Append the orchestrator addendum to the system prompt. */
  orchestrator: boolean;
  /** Enable the phase pipeline (advance_phase + stall nags) at depth 0. */
  pipeline: boolean;
  /** Max validate→blueprint corrective re-entries when validation reports blockers (default 2). */
  maxBackwardJumps: number;
  /** Summarize the trajectory when it grows past the threshold (keeps the root window small). */
  compaction: boolean;
  /** Compact when estimated history tokens reach this fraction of the model's context window. */
  compactionThresholdPct: number;
  /** Python executable used to launch the sandbox worker. */
  python: string;
  /** Worker startup wait before treating sandbox init as failed (ms). */
  sandboxInitTimeoutMs: number;
  /** Allow ask_user_question() calls from the root REPL. */
  askUserQuestion: boolean;
  /** Allow todo() calls from the REPL. */
  todo: boolean;
  /** Enable the load_library() REPL scaffold (external dirs/files/git repos as extra context slots). */
  libraryLoader: boolean;
  /** ThinkingLevel for the root smart model (set via /rlm-config). */
  smartReasoning?: ThinkingLevel;
  /** Output token cap + temperature for the root smart model per turn.
   *  Keeps each turn short so the next turn's input stays manageable.
   *  `reasoning` is read from `smartReasoning` if omitted here. */
  rootSampling?: Readonly<Sampling>;
  /** System prompt injected into every llm_query / llm_query_batched sub-call.
   *  Instructs the worker model to respond concisely.
   *  undefined = no system prompt (raw completion). */
  subSystemPrompt?: string;
  /** Sampling for sub-LLM (worker) calls. */
  subSampling: MutableSampling;
  /** Optional run-state persistence configuration. Enabled by default. */
  readonly runLog?: RunLogConfig;
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
  /** Depth-0 resume payload — controller rebuilds this from the trail's `reconstructRlmState()`. */
  readonly resume?: ReconstructResult & { readonly ok: true };
}

/** Result of a completed RLM run. */
export interface RlmResult {
  readonly answer: string;
  /** Legacy anchor edits retained for compatibility while older run-state rows exist. */
  readonly edits?: readonly ProposedEdit[];
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
  /** Called when the sandbox issues todo; undefined = feature disabled. */
  readonly onTodo?: (action: string, params: Record<string, unknown>) => Promise<string>;
}

export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
