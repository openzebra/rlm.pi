import type { RlmConfig } from "../core/types.ts";

export const DEFAULT_CONFIG: RlmConfig = {
  enabled: true,
  maxDepth: 2,
  maxIterations: 30,
  execTimeoutS: 120,
  requestTimeoutMs: 10 * 60_000,
  maxConcurrentSubcalls: 4,
  maxPromptChars: 400_000,
  maxErrors: 5,
  orchestrator: true,
  compaction: true,
  compactionThresholdPct: 0.85,
  python: "python3",
  fsLimits: Object.freeze({
    maxReadBytes: 10 * 1024 * 1024,
    maxOutputChars: 20_000,
    maxFindFiles: 2_000,
    maxManifestFiles: 5_000,
    commandTimeoutMs: 15_000,
    grepDefaultMaxMatches: 200,
    grepMaxMatchesCeiling: 1_000,
  }),
  sandboxInitTimeoutMs: 30_000,
  editEnabled: false,
  allowReadOutsideWorkspace: false,
  subSampling: Object.freeze({ maxTokens: 8192 }),
};
