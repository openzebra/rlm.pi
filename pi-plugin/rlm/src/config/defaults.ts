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
  // the only thing bounding leaf fan-out.
  maxConcurrentSubcalls: 16,
  // Children are bounded separately and lower: each is a Python subprocess holding its own copy
  // of the context it inherited, where a leaf is one HTTP request. Worst case is
  // (maxDepth - 1) × this many concurrent child engines.
  maxConcurrentChildren: 6,
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
  // v5 durable memory
  enableMemory: true,
  injectNoteTokens: 2_000,
  evolveEvery: 8,
  memoryDir: null,
  // v5 role separation: children delegate (llm + memory/ledger); "legacy" = full child surface.
  childSurface: "delegation",
});
