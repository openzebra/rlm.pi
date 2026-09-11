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
  /** Max turns before the engine must finalize. Deliberately large — runs end on FINAL
   *  answer, errors, or wall-clock long before this bites. */
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
  /** v5.1 rate-limit resilience (see util/retry.ts): transient 429/5xx are retried with
   *  backoff, and rate limits additionally cool a shared per-provider throttle.
   *  retryMaxAttempts counts TOTAL attempts per call (1 = never retry).
   *  rateLimitMaxAttempts is the SEPARATE budget a 429 may burn while parking on the
   *  cooldown — generous, because "come back later" is a queue, not a failure. */
  readonly retryMaxAttempts?: number;
  readonly rateLimitMaxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  /** Cap for any single retry delay, including a parsed `retry-after`. */
  readonly retryMaxDelayMs?: number;
  /** First cooldown when a provider 429s without timing; doubles per consecutive strike. */
  readonly throttleBaseMs?: number;
  /** Ceiling for the adaptive per-provider cooldown. */
  readonly throttleMaxMs?: number;
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
  /** DEPRECATED (LO rule 2025-09-09): ignored — compaction is governed by the absolute
   *  COMPACTION_CEILING_TOKENS (limits.ts). Kept for settings/UI compatibility only. */
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
  /** v5: per-provider concurrent-request caps (e.g. `{ zai: 4 }`). Caps only lower limits. */
  readonly providerMaxConcurrent?: Readonly<Record<string, number>>;
  /** Verification-discipline nudge (default OFF — it changes interactive behavior): when the
   *  root finalizes before turn 4 with a bare number / short label, it gets ONE coached redo
   *  ("recompute and sanity-check in Python") instead of accepting the answer. Opt-in via
   *  rlm.json; evidence: 28/33 bench failures were early confident wrong answers. */
  readonly enableVerificationNudge?: boolean;
  // ── SKILL.state integration (Workstreams A–F) ──
  /** Structured execution state Σ_t in headless runs (paper §3); false = as-built append-only
   *  history + prose compaction. Degraded automatically on malformed-patch retry exhaustion. */
  readonly enableRunState: boolean;
  /** Failed state-patch applications tolerated before the run degrades to as-built behavior. */
  readonly runStateRetryMax: number;
  /** Cross-session SkillState store: Ξ prompt injection (C), leaf grounding (D), skill_search (E). */
  readonly enableSkillState: boolean;
  /** Opt-in: one cheap leaf call at run finalize to phrase A-Mem-style notes from the run. */
  readonly enableSkillStateDistill: boolean;
  /** Token budget for the injected Ξ skill block (Workstream C). */
  readonly skillStateMaxTokens: number;
  /** Per-leaf-call grounding budget in tokens (Workstream D). */
  readonly skillStateLeafTokens: number;
  /** BM25 score a note must clear before a leaf prompt gets grounded (below ⇒ byte-identical). */
  readonly skillStateMinScore: number;
  /** Per-project note cap; LRU by ts with the top-hits quartile pinned (Workstream B). */
  readonly skillStateNotesPerProject: number;

  // ── Root Σ integration (Root Σ plan WS-2..WS-4) ──
  /** Deterministic root compaction: when the Pi session compacts, supply a no-LLM structural
   *  digest ([Task]/[Findings]/[State]/[Next]/[Project facts]) instead of Pi's LLM prose
  *  summarizer. Fail-soft: any error falls back to the host path. */
  readonly enableRootDigestCompaction: boolean;
  /** Verbatim tail (chars) the root digest keeps out of the digest span — entries after the
   *  chosen cut stay byte-identical in context (never summarized). */
  readonly rootDigestKeepRecentChars: number;
  /** Cap for the generated digest string; over-cap drops sections in continuity order. */
  readonly rootDigestMaxChars: number;
  /** Per-LLM-call root A_t assembly via the `context` event (WS-3): elide stale tool
   *  payloads (paper §5.3 discard) + splice the fresh Σ snapshot. Default OFF until soak. */
  readonly enableRootContextTransform: boolean;
  /** Newest assistant turns kept verbatim by the root elision (mirrors engine keepTurns). */
  readonly rootContextKeepTurns: number;
  /** Tool-result payloads older than the keep window are preview-capped at this many chars. */
  readonly rootContextElideChars: number;
  /** Splice the RootStateTracker Σ snapshot before the last user message each call. */
  readonly rootContextSnapshot: boolean;
  /** WS-4.2 (default OFF, paper §5.7 fence tax): the root may commit ΔΣ_t via a ```state
   *  fence in a normal reply; patches ride the same V(ΔΣ_t,Σ_t) ladder as engine runs. */
  readonly enableRootStateFences: boolean;
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
  /** SKILL.state Ξ (Workstream C) — the BM25-selected SkillState block this run conditions on.
   *  Set by the composition root / copied by childRun (DRY #6 — one construction site). */
  readonly skillBlock?: string;
  /** History-as-deliverable opt-out (paper §7-c): when true, RunState never activates — the
   *  archive is the product (audit / provenance / debug-narrative runs). */
  readonly narrative?: boolean;
  /** Workstream F: a rectification chosen by the prior run at its budget hard-state, applied to
   *  THIS continuation invocation (narrowed child paths / reduced leaf admission). DOCTRINE:
   *  never a model/provider switch — a failing model retries to exhaustion and fails. */
  readonly rectification?: import("./budget.ts").RectifyAction;
}

/** Result of a completed RLM run. */
export interface RlmResult {
  readonly answer: string;
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** Last non-empty repl stdout of the run (capped, P2 §3.4). The engine itself never reads
   *  it: a run that ends without `answer[...]` (no final frame) would otherwise score as an
   *  empty submission even though the winning value was printed. The bench/grader recovers
   *  that value from here instead of re-running the whole task. */
  readonly lastStdout: string;
}

/** A function that runs an RLM to completion — used to wire recursion (rlm_query). */
export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
