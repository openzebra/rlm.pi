import type { RlmConfig } from "../core/types.ts";

export const DEFAULT_CONFIG: RlmConfig = {
  maxDepth: 2,
  maxIterations: 30,
  execTimeoutS: 120,
  requestTimeoutMs: 10 * 60_000,
  maxConcurrentSubcalls: 4,
  maxPromptChars: 400_000,
  orchestrator: true,
  compaction: false,
  compactionThresholdPct: 0.85,
  python: "python3",
  subSampling: { maxTokens: 8192 },
};
