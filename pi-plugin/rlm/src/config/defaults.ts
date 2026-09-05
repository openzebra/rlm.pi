import type { RlmConfig } from "../core/types.ts";

/** Frozen default sub-LLM system prompt — avoids re-allocation on every llm_query call. */
const DEFAULT_SUB_SYSTEM_PROMPT =
  "Answer directly and concisely. Return only the requested information. " +
  "No preamble, no meta-commentary, no explanation of your approach. " +
  "If listing items, use compact bullet form.";

export const DEFAULT_CONFIG: Readonly<RlmConfig> = Object.freeze({
  enabled: true,
  maxDepth: 4,
  maxIterations: 30,
  execTimeoutS: 120,
  requestTimeoutMs: 15 * 60_000,
  // Session-wide, not per-batch: spawn() puts many requests on the wire at once, so this is
  // the only thing bounding leaf fan-out. Default 8 — a sane rate for per-account limits
  // (raise to 16/32 via /rlm-config when the provider allows).
  maxConcurrentSubcalls: 8,
  // Children are bounded separately and lower: each is a Python subprocess holding its own copy
  // of the context it inherited, where a leaf is one HTTP request. Worst case is
  // (maxDepth - 1) × this many concurrent child engines. Default 4.
  maxConcurrentChildren: 4,
  // v5.1 rate-limit resilience (util/retry.ts): 3 total attempts, 500ms→15s backoff,
  // 2s→60s adaptive per-provider cooldown. All overridable in rlm.json.
  retryMaxAttempts: 3,
  // 429s park on the cooldown instead of dying — up to 8 windows (2s→4s→…≤60s ≈ 4 min).
  rateLimitMaxAttempts: 8,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 15_000,
  throttleBaseMs: 2_000,
  throttleMaxMs: 60_000,
  maxPromptChars: 400_000,
  maxErrors: 5,
  orchestrator: true,
  compaction: true,
  compactionThresholdPct: 0.65,
  python: "python3",
  sandboxInitTimeoutMs: 30_000,
  contextLoader: true,
  autoSeedCwd: true,
  rootSampling: Object.freeze({ maxTokens: 16_384 }),
  subSystemPrompt: DEFAULT_SUB_SYSTEM_PROMPT,
  subSampling: Object.freeze({ maxTokens: 8192 }),
  // v5 token budget cascade — the primary run-length control (wall-clock stays a hang backstop).
  enableTokenBudget: true,
  budgetShare: 0.25,
  budgetSoftFrac: 0.8,
  budgetTaskCap: 400_000,
  budgetMaxContinuations: 2,
  budgetHandoffChars: 4_000,
  // v5 TaskLedger blackboard
  enableLedger: true,
  rlmBudget: 8,
  // v5 role separation: children delegate (llm + ledger); "legacy" = full child surface.
  childSurface: "delegation",
  // Verification-discipline nudge — deliberately OFF (plan guardrail): when on, an early
  // bare-number finalize gets one coached redo instead of being accepted. Opt-in via rlm.json.
  enableVerificationNudge: false,
});
