/** Persist RLM settings (tunable config + chosen smart/worker model ids). */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { RlmConfig, RunLogConfig, TelemetryConfig } from "../core/types.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

export interface PersistedSettings {
  readonly config: Partial<RlmConfig>;
  readonly smart?: string;
  readonly worker?: string;
}

type MutablePartialRlmConfig = { -readonly [K in keyof RlmConfig]?: RlmConfig[K] };

function settingsPath(): string {
  return join(getAgentDir(), "rlm.json");
}

function validateNumber(v: unknown, min: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined;
}

function validateBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function validateString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function validateTelemetry(raw: unknown): TelemetryConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: {
    enabled?: boolean;
    trackingUri?: string;
    experimentId?: string;
    maxQueueSize?: number;
  } = {};
  const enabled = validateBoolean(r.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const trackingUri = validateString(r.trackingUri);
  if (trackingUri !== undefined) out.trackingUri = trackingUri;
  const experimentId = validateString(r.experimentId);
  if (experimentId !== undefined) out.experimentId = experimentId;
  const maxQueueSize = validateNumber(r.maxQueueSize, 1);
  if (maxQueueSize !== undefined) out.maxQueueSize = maxQueueSize;
  return Object.freeze(out);
}

function validateRunLog(raw: unknown): Partial<RunLogConfig> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: { enabled?: boolean; dir?: string; snapshot?: boolean; maxRuns?: number } = {};
  const enabled = validateBoolean(r.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const dir = validateString(r.dir);
  if (dir !== undefined) out.dir = dir;
  const snapshot = validateBoolean(r.snapshot);
  if (snapshot !== undefined) out.snapshot = snapshot;
  const maxRuns = validateNumber(r.maxRuns, 1);
  if (maxRuns !== undefined) out.maxRuns = maxRuns;
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

function validateConfig(raw: unknown): Partial<RlmConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: MutablePartialRlmConfig = {};
  const enabled = validateBoolean(r.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const maxDepth = validateNumber(r.maxDepth, 1);
  if (maxDepth !== undefined) out.maxDepth = maxDepth;
  const maxIterations = validateNumber(r.maxIterations, 1);
  if (maxIterations !== undefined) out.maxIterations = maxIterations;
  const execTimeoutS = validateNumber(r.execTimeoutS, 1);
  if (execTimeoutS !== undefined) out.execTimeoutS = execTimeoutS;
  const requestTimeoutMs = validateNumber(r.requestTimeoutMs, 1000);
  if (requestTimeoutMs !== undefined) out.requestTimeoutMs = requestTimeoutMs;
  const maxConcurrentSubcalls = validateNumber(r.maxConcurrentSubcalls, 1);
  if (maxConcurrentSubcalls !== undefined) out.maxConcurrentSubcalls = maxConcurrentSubcalls;
  const maxPromptChars = validateNumber(r.maxPromptChars, 1000);
  if (maxPromptChars !== undefined) out.maxPromptChars = maxPromptChars;
  const maxBudgetUsd = validateNumber(r.maxBudgetUsd, 0.01);
  if (maxBudgetUsd !== undefined) out.maxBudgetUsd = maxBudgetUsd;
  const maxTimeoutMs = validateNumber(r.maxTimeoutMs, 1000);
  if (maxTimeoutMs !== undefined) out.maxTimeoutMs = maxTimeoutMs;
  const maxTokens = validateNumber(r.maxTokens, 1);
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const maxErrors = validateNumber(r.maxErrors, 1);
  if (maxErrors !== undefined) out.maxErrors = maxErrors;
  const orchestrator = validateBoolean(r.orchestrator);
  if (orchestrator !== undefined) out.orchestrator = orchestrator;
  const compaction = validateBoolean(r.compaction);
  if (compaction !== undefined) out.compaction = compaction;
  const compactionThresholdPct = validateNumber(r.compactionThresholdPct, 0);
  if (compactionThresholdPct !== undefined && compactionThresholdPct <= 1) out.compactionThresholdPct = compactionThresholdPct;
  const python = validateString(r.python);
  if (python !== undefined) out.python = python;
  if (typeof r.smartReasoning === "string") out.smartReasoning = r.smartReasoning as ThinkingLevel;
  const telemetry = validateTelemetry(r.telemetry);
  if (telemetry) out.telemetry = telemetry;
  const runLog = validateRunLog(r.runLog);
  if (runLog) out.runLog = runLog;
  const sandboxInitTimeoutMs = validateNumber(r.sandboxInitTimeoutMs, 100);
  if (sandboxInitTimeoutMs !== undefined) out.sandboxInitTimeoutMs = sandboxInitTimeoutMs;
  const askUserQuestion = validateBoolean(r.askUserQuestion);
  if (askUserQuestion !== undefined) out.askUserQuestion = askUserQuestion;
  const todo = validateBoolean(r.todo);
  if (todo !== undefined) out.todo = todo;
  if (typeof r.subSampling === "object" && r.subSampling !== null) {
    const ss = r.subSampling as Record<string, unknown>;
    const sampling: { maxTokens?: number; temperature?: number; reasoning?: ThinkingLevel } = {};
    const maxTokensValue = validateNumber(ss.maxTokens, 1);
    if (maxTokensValue !== undefined) sampling.maxTokens = maxTokensValue;
    const temperature = validateNumber(ss.temperature, 0);
    if (temperature !== undefined) sampling.temperature = temperature;
    if (typeof ss.reasoning === "string") sampling.reasoning = ss.reasoning as ThinkingLevel;
    out.subSampling = sampling;
  }
  return out;
}

export async function loadSettings(): Promise<PersistedSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return { config: {} };
    const r = raw as Record<string, unknown>;
    return {
      config: validateConfig(r.config),
      smart: typeof r.smart === "string" ? r.smart : undefined,
      worker: typeof r.worker === "string" ? r.worker : undefined,
    };
  } catch {
    return { config: {} };
  }
}

export async function saveSettings(s: PersistedSettings): Promise<boolean> {
  try {
    const p = settingsPath();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, `${JSON.stringify(s, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Merge persisted tunables over the defaults. */
export function mergeConfig(partial: Partial<RlmConfig>): RlmConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    subSampling: { ...DEFAULT_CONFIG.subSampling, ...partial.subSampling },
    ...(partial.telemetry ? { telemetry: Object.freeze({ ...partial.telemetry }) } : {}),
    ...(partial.runLog ? { runLog: Object.freeze({ ...DEFAULT_CONFIG.runLog, ...partial.runLog }) } : {}),
  };
}

/** Resolve a "provider/id" string against the registry. */
export function resolveModelId(registry: ModelRegistry, ref?: string): Model<Api> | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash < 0) return undefined;
  return registry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

export function modelRef(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}
