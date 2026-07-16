import type { RlmConfig } from "../core/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RUN_DIR = join(tmpdir(), "rlm-runs");

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
  requestTimeoutMs: 10 * 60_000,
  maxConcurrentSubcalls: 4,
  maxPromptChars: 400_000,
  maxErrors: 5,
  orchestrator: true,
  pipeline: false,
  maxBackwardJumps: 2,
  compaction: true,
  compactionThresholdPct: 0.65,
  python: "python3",
  sandboxInitTimeoutMs: 30_000,
  askUserQuestion: true,
  todo: true,
  rootSampling: Object.freeze({ maxTokens: 16_384 }),
  subSystemPrompt: DEFAULT_SUB_SYSTEM_PROMPT,
  subSampling: Object.freeze({ maxTokens: 8192 }),
  runLog: Object.freeze({
    enabled: true,
    dir: DEFAULT_RUN_DIR,
    snapshot: true,
    maxRuns: 50,
  }),
});
