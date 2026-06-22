/**
 * Persist RLM settings (tunable config + chosen smart/worker model ids) to
 * `<agentDir>/rlm.json` so `/rlm-config` choices survive restarts. Best-effort: any read/write
 * error falls back to defaults silently.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RlmConfig, Sampling } from "../core/types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "./defaults.ts";

export interface PersistedSettings {
  config: Partial<RlmConfig>;
  smart?: string; // "provider/id"
  worker?: string;
}

function settingsPath(): string {
  return join(getAgentDir(), "rlm.json");
}

function validateNumber(v: unknown, min: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined;
}

function validateConfig(raw: unknown): Partial<RlmConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RlmConfig> = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (validateNumber(r.maxDepth, 1)) out.maxDepth = r.maxDepth as number;
  if (validateNumber(r.maxIterations, 1)) out.maxIterations = r.maxIterations as number;
  if (validateNumber(r.execTimeoutS, 1)) out.execTimeoutS = r.execTimeoutS as number;
  if (validateNumber(r.requestTimeoutMs, 1000)) out.requestTimeoutMs = r.requestTimeoutMs as number;
  if (validateNumber(r.maxConcurrentSubcalls, 1)) out.maxConcurrentSubcalls = r.maxConcurrentSubcalls as number;
  if (validateNumber(r.maxPromptChars, 1000)) out.maxPromptChars = r.maxPromptChars as number;
  if (validateNumber(r.maxBudgetUsd, 0.01)) out.maxBudgetUsd = r.maxBudgetUsd as number;
  if (validateNumber(r.maxTimeoutMs, 1000)) out.maxTimeoutMs = r.maxTimeoutMs as number;
  if (validateNumber(r.maxTokens, 1)) out.maxTokens = r.maxTokens as number;
  if (validateNumber(r.maxErrors, 1)) out.maxErrors = r.maxErrors as number;
  if (typeof r.orchestrator === "boolean") out.orchestrator = r.orchestrator;
  if (typeof r.compaction === "boolean") out.compaction = r.compaction;
  if (validateNumber(r.compactionThresholdPct, 0) && (r.compactionThresholdPct as number) <= 1) out.compactionThresholdPct = r.compactionThresholdPct as number;
  if (typeof r.python === "string" && r.python.trim()) out.python = r.python;
  if (typeof r.smartReasoning === "string") out.smartReasoning = r.smartReasoning as ThinkingLevel;
  if (typeof r.subSampling === "object" && r.subSampling !== null) {
    const ss = r.subSampling as Record<string, unknown>;
    const sampling: Partial<Sampling> = {};
    if (validateNumber(ss.maxTokens, 1)) sampling.maxTokens = ss.maxTokens as number;
    if (validateNumber(ss.temperature, 0)) sampling.temperature = ss.temperature as number;
    if (typeof ss.reasoning === "string") sampling.reasoning = ss.reasoning as ThinkingLevel;
    out.subSampling = sampling as Sampling;
  }
  return out;
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
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

export function saveSettings(s: PersistedSettings): void {
  try {
    const p = settingsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/** Merge persisted tunables over the defaults. */
export function mergeConfig(partial: Partial<RlmConfig>): RlmConfig {
  return { ...DEFAULT_CONFIG, ...partial, subSampling: { ...DEFAULT_CONFIG.subSampling, ...partial.subSampling } };
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
