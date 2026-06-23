/** Persist RLM settings (tunable config + chosen smart/worker model ids). */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { FsLimits, RlmConfig, Sampling } from "../core/types.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

export interface PersistedSettings {
  config: Partial<RlmConfig>;
  smart?: string;
  worker?: string;
}

function settingsPath(): string {
  return join(getAgentDir(), "rlm.json");
}

function validateNumber(v: unknown, min: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined;
}

function validateBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function validateFsLimits(raw: unknown): Partial<FsLimits> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<FsLimits> = {};
  const fields: ReadonlyArray<readonly [keyof FsLimits, number]> = Object.freeze([
    ["maxReadBytes", 1],
    ["maxOutputChars", 1],
    ["maxFindFiles", 1],
    ["maxManifestFiles", 1],
    ["commandTimeoutMs", 100],
    ["grepDefaultMaxMatches", 1],
    ["grepMaxMatchesCeiling", 1],
  ]);
  for (const [key, min] of fields) {
    const value = validateNumber(r[key], min);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateConfig(raw: unknown): Partial<RlmConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RlmConfig> = {};
  const enabled = validateBoolean(r.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  if (validateNumber(r.maxDepth, 1) !== undefined) out.maxDepth = r.maxDepth as number;
  if (validateNumber(r.maxIterations, 1) !== undefined) out.maxIterations = r.maxIterations as number;
  if (validateNumber(r.execTimeoutS, 1) !== undefined) out.execTimeoutS = r.execTimeoutS as number;
  if (validateNumber(r.requestTimeoutMs, 1000) !== undefined) out.requestTimeoutMs = r.requestTimeoutMs as number;
  if (validateNumber(r.maxConcurrentSubcalls, 1) !== undefined) out.maxConcurrentSubcalls = r.maxConcurrentSubcalls as number;
  if (validateNumber(r.maxPromptChars, 1000) !== undefined) out.maxPromptChars = r.maxPromptChars as number;
  if (validateNumber(r.maxBudgetUsd, 0.01) !== undefined) out.maxBudgetUsd = r.maxBudgetUsd as number;
  if (validateNumber(r.maxTimeoutMs, 1000) !== undefined) out.maxTimeoutMs = r.maxTimeoutMs as number;
  if (validateNumber(r.maxTokens, 1) !== undefined) out.maxTokens = r.maxTokens as number;
  if (validateNumber(r.maxErrors, 1) !== undefined) out.maxErrors = r.maxErrors as number;
  const orchestrator = validateBoolean(r.orchestrator);
  if (orchestrator !== undefined) out.orchestrator = orchestrator;
  const compaction = validateBoolean(r.compaction);
  if (compaction !== undefined) out.compaction = compaction;
  if (validateNumber(r.compactionThresholdPct, 0) !== undefined && (r.compactionThresholdPct as number) <= 1) out.compactionThresholdPct = r.compactionThresholdPct as number;
  if (typeof r.python === "string" && r.python.trim()) out.python = r.python;
  if (typeof r.smartReasoning === "string") out.smartReasoning = r.smartReasoning as ThinkingLevel;
  const fsLimits = validateFsLimits(r.fsLimits);
  if (fsLimits) out.fsLimits = fsLimits as FsLimits;
  if (validateNumber(r.sandboxInitTimeoutMs, 100) !== undefined) out.sandboxInitTimeoutMs = r.sandboxInitTimeoutMs as number;
  const editEnabled = validateBoolean(r.editEnabled);
  if (editEnabled !== undefined) out.editEnabled = editEnabled;
  const allowReadOutsideWorkspace = validateBoolean(r.allowReadOutsideWorkspace);
  if (allowReadOutsideWorkspace !== undefined) out.allowReadOutsideWorkspace = allowReadOutsideWorkspace;
  if (typeof r.subSampling === "object" && r.subSampling !== null) {
    const ss = r.subSampling as Record<string, unknown>;
    const sampling: Partial<Sampling> = {};
    if (validateNumber(ss.maxTokens, 1) !== undefined) sampling.maxTokens = ss.maxTokens as number;
    if (validateNumber(ss.temperature, 0) !== undefined) sampling.temperature = ss.temperature as number;
    if (typeof ss.reasoning === "string") sampling.reasoning = ss.reasoning as ThinkingLevel;
    out.subSampling = sampling as Sampling;
  }
  return out;
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
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

export function saveSettings(s: PersistedSettings): boolean {
  try {
    const p = settingsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
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
    fsLimits: { ...DEFAULT_CONFIG.fsLimits, ...partial.fsLimits },
    subSampling: { ...DEFAULT_CONFIG.subSampling, ...partial.subSampling },
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
