import type { RlmConfig } from "../core/types.ts";

/**
 * Frozen default sub-LLM system prompt — avoids re-allocation on every llm_query call.
 * Anthropic prompting canon applied: a role ("precise extraction assistant") and the
 * hallucination out ("reply exactly NOT_FOUND when the material lacks the answer") — the
 * convention the glossary documents so roots can branch on a leaf's NOT_FOUND instead of
 * retrying identical prompts against slices that cannot answer.
 */
const DEFAULT_SUB_SYSTEM_PROMPT =
  "You are a precise extraction and analysis assistant. " +
  "Answer directly and concisely from the material provided in the prompt. " +
  "Return only the requested information — no preamble, no meta-commentary, no explanation of your approach. " +
  "If listing items, use compact bullet form. " +
  "If the material does not contain the answer, reply exactly: NOT_FOUND";

export const DEFAULT_CONFIG: Readonly<RlmConfig> = Object.freeze({
  enabled: true,
  maxDepth: 4,
  // Max-long runs: the engine may keep iterating until budget/compaction walls hit. The budget
  // cascade and compactionThresholdPct are the real length controls; this ceiling only stops
  // truly runaway loops. Was 30 — capped long tasks prematurely.
  // Strongly oversized on purpose: runs end on FINAL answer / errors / wall-clock long
  // before this bites. History: 30 capped long tasks; the bench's 16 all-failed oolong
  // mid-retrieval. 1000 ≈ 5× the old interactive default, effectively a runaway backstop.
  maxIterations: 1_000,
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
  // v5.1 rate-limit resilience (util/retry.ts): 15 total attempts on the SAME model —
  // 500ms→15s backoff, 2s→60s adaptive per-provider cooldown. DOCTRINE: NO fallback —
  // when the attempts are exhausted the call fails loudly; model/provider never switch.
  retryMaxAttempts: 15,
  // 429s park on the cooldown instead of dying — up to 15 windows (2s→4s→…≤60s).
  rateLimitMaxAttempts: 15,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 15_000,
  throttleBaseMs: 2_000,
  throttleMaxMs: 60_000,
  maxPromptChars: 400_000,
  maxErrors: 5,
  orchestrator: true,
  compaction: true,
  // Compact only near the hard ceiling: ≈125K of the default 128K window (0.976). Earlier
  // compaction (0.65) amputated usable working memory long before it was needed.
  // DEPRECATED: ignored since the absolute 256k compaction ceiling (limits.ts); kept so old
  // rlm.json files still load. Do not read this value in new code.
  compactionThresholdPct: 0.976,
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
  budgetTaskCap: 1_000_000,
  budgetMaxContinuations: 2,
  // 24K: the handoff must carry Σ + findings + query verbatim — a 4K skeleton is what made
  // long research runs "lose context" on hard-budget continuation (amputated, not lost).
  budgetHandoffChars: 24_000,
  // v5 TaskLedger blackboard
  enableLedger: true,
  rlmBudget: 8,
  // Verification-discipline nudge — default ON (knowlange rec: 28/33 bench failures were
  // early confident wrong answers; the RLM paper ships the same discipline). An early bare
  // finalize — or one from a run that never inspected its context — gets ONE coached redo
  // before the answer is accepted. Opt out via rlm.json (`"enableVerificationNudge": false`).
  enableVerificationNudge: true,
  // SKILL.state integration: Σ_t execution state + cross-session distilled knowledge.
  // Paradigm flags are ENFORCED (R0, /tmp/ROOT_FULL_SKILLSTATE_PLAN.md) — validateEnforcedOn
  // forces true whatever rlm.json carries; only calibrations are tunable.
  enableRunState: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0
  runStateRetryMax: 2,
  enableSkillState: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0
  // Default ON (bench rec #3): deterministic harvest — one cheap distill leaf per finalize
  // replaces the stochastic fence-emission harvest (0 vs 4 notes across identical ON arms).
  enableSkillStateDistill: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0
  skillStateMaxTokens: 1_200,
  skillStateLeafTokens: 200,
  // 2.5 (was 4.0 — recall W3): at 4.0 grounding silently no-oped on most prompts; 2.5 keeps
  // the byte-identical-below-threshold contract while letting genuinely-relevant facts land.
  skillStateMinScore: 2.5,
  // Ξ block floor (recall W3): was Number.MIN_VALUE — every positively-scored stale note
  // rode every root prompt. 2.0 admits relevant notes without the cross-session noise.
  skillStateXiMinScore: 2.0,
  skillStateNotesPerProject: 128,
  // Root Σ integration (WS-2..WS-4): every LLM call assembles A_t = (P, Σ_t, O_t) — discard
  // semantics on stale payloads + exactly one Σ snapshot splice, and model-proposed ΔΣ_t
  // fences taught in the native prompt (v2 R1/R2). Digest compaction swaps Pi's summarizer
  // for a deterministic digest. Flags are ENFORCED (R0); RLM_BENCH_NO_ROOTCONTEXT=1 remains
  // the dev-only A/B measurement hatch — it alters measurement, never ships as a disable path.
  enableRootDigestCompaction: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0
  rootDigestKeepRecentChars: 12_000,
  rootDigestMaxChars: 8_000,
  enableRootContextTransform: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0 (was soak-OFF pre-v2)
  // Recall W4 calibration: 4 verbatim turns (was 2). SKILL.state's budget-matched ablation
  // (Table 5/11) shows truncated windows collapse recall (0.18 vs structured 0.94); a 2-turn
  // window sat dangerously close to that shape. Still O(1) per call; the session archive
  // (rootArchiveMaxChars) makes anything older dereferenceable instead of gone.
  rootContextKeepTurns: 4,
  rootContextElideChars: 3_000,
  // Recall W1: elided turns archive into the sandbox (ctx/session-log/*) so search()/
  // grep_context() recall them — elision becomes dereferenceable, and the stubs stay honest.
  // 0 disables the archive (stubs degrade to the plain Σ line).
  rootArchiveMaxChars: 2_000_000,
  rootContextSnapshot: true,
  enableRootStateFences: true, // ENFORCED — see /tmp/ROOT_FULL_SKILLSTATE_PLAN.md R0 (was soak-OFF pre-v2)
});
