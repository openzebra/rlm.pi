/** Shared configuration + runtime types for the RLM engine. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

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
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds).
   *  v5 doctrine: content limits are the token budget's job — this is a HANG backstop only. */
  readonly execTimeoutS: number;
  /** Parent-side watchdog per sandbox request (ms). Hang backstop (see execTimeoutS). */
  readonly requestTimeoutMs: number;
  /** Concurrency pool for *_batched sub-calls. */
  readonly maxConcurrentSubcalls: number;
  /** Concurrent recursive child engines admitted per depth. Lower than maxConcurrentSubcalls:
   *  each child is a Python subprocess holding its own copy of the inherited context. */
  readonly maxConcurrentChildren: number;
  /** Reject sub-LLM prompts larger than this many chars. */
  readonly maxPromptChars: number;
  /** Max wall-clock ms across the whole tree before the engine stops (undefined = no cap). */
  readonly maxTimeoutMs?: number;
  /** Max total input+output tokens across the whole tree before the engine stops (undefined = no cap).
 *  ⚠ HARD ABORT (audit H8): when set, exceeding this throws a LimitError mid-run and the run
 *  ends with its best partial — NO wrap-up, NO continuation. The graceful path is the v5
 *  token budget (`enableTokenBudget`); leave this unset unless a hard tree-wide stop is wanted. */
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
  /** Enable the add_context() REPL scaffold (external dirs/files/git repos/documents into context). */
  readonly contextLoader: boolean;
  /**
   * When true, the first repl() call seeds `context` with the working directory
   * (un-prefixed paths). When false, context stays empty until add_context is called.
   */
  readonly autoSeedCwd: boolean;
  /** ThinkingLevel for the root smart model (set via /rlm-config). */
  readonly smartReasoning?: ThinkingLevel;
  /** Output token cap + temperature for the root smart model per turn.
   *  Keeps each turn short so the next turn's input stays manageable.
   *  `reasoning` is read from `smartReasoning` if omitted here. */
  readonly rootSampling?: Readonly<Sampling>;
  /** System prompt injected into every llm_query / llm_batch sub-call.
   *  Instructs the worker model to respond concisely.
   *  undefined = no system prompt (raw completion). */
  readonly subSystemPrompt?: string;
  /** Sampling for sub-LLM (worker) calls. */
  readonly subSampling: Readonly<Sampling>;
  /** v5 token budget: cap = budgetShare × contextWindow, clamped by budgetTaskCap. When on,
   *  the budget is the PRIMARY run-length control (soft wrap-up → continuation chain). */
  readonly enableTokenBudget: boolean;
  /** Fraction of the model's context window that forms one run's token cap. */
  readonly budgetShare: number;
  /** Soft wrap-up fires at this fraction of the cap (one wrap-up turn). */
  readonly budgetSoftFrac: number;
  /** Absolute single-run ceiling; 0 = no clamp beyond the share. */
  readonly budgetTaskCap: number;
  /** Max continuation runs after a hard stop (chain ≤ 1 + this). */
  readonly budgetMaxContinuations: number;
  /** Char budget for the deterministic continuation handoff. */
  readonly budgetHandoffChars: number;
  /** v5 TaskLedger blackboard: claim coalescing + ancestor-echo reject + `[ledger]` injection. */
  readonly enableLedger: boolean;
  /** Real rlm spawns allowed before extra rlm_query demotes to llm_query (0 = never). */
  readonly rlmBudget: number;
  /** v5 durable memory: L1 episode replay + L2 BM25 notes under `<root>/.rlm/memory`. */
  readonly enableMemory: boolean;
  /** Char budget for the `[memory]` injection = tokens × 4. */
  readonly injectNoteTokens: number;
  /** Pending episodes per L2 consolidation batch (0 = never auto-consolidate). */
  readonly evolveEvery: number;
  /** Override the memory dir. `null` (default) = `<root>/.rlm/memory` — this field only
 *  RELOCATES the store; the on/off switch is `enableMemory` (audit M3). */
  readonly memoryDir: string | null;
  /** v5: per-provider concurrent-request caps (e.g. `{ zai: 4 }`). Caps only lower limits. */
  readonly providerMaxConcurrent?: Readonly<Record<string, number>>;
  /** v5 doctrine: "delegation" = child engines get llm/memory/ledger only (no repo retrieval);
   *  "legacy" keeps today's full child surface as a one-flip rollback. */
  readonly childSurface: "delegation" | "legacy";
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
  /** Remaining timeout for this subtree (set by parent from its LimitGuard). */
  readonly remainingTimeoutMs?: number;
  /** v5: budget for this run. Set only by the engine itself when chaining a continuation —
   *  a fresh budget is resolved from config when omitted. */
  readonly budget?: import("./budget.ts").TokenBudget;
  /** v5: the shared TaskLedger blackboard. Children inherit the parent's instance —
   *  set by childRun (the one child-RlmInput construction path); a fresh run gets a new one. */
  readonly ledger?: import("./ledger.ts").TaskLedger;
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
export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
