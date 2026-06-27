import type { RlmConfig } from "../core/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RUN_DIR = join(tmpdir(), "rlm-runs");

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
  compaction: true,
  compactionThresholdPct: 0.85,
  python: "python3",
  sandboxInitTimeoutMs: 30_000,
  askUserQuestion: true,
  todo: true,
  yolo: false,
  subSampling: Object.freeze({ maxTokens: 8192 }),
  runLog: Object.freeze({
    enabled: true,
    dir: DEFAULT_RUN_DIR,
    snapshot: true,
    maxRuns: 50,
  }),
});
