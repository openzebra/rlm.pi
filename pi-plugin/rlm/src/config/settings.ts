/** Persist RLM settings (tunable config + pinned sub-LLM model id). */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { RlmConfig } from "../core/types.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

export interface PersistedSettings {
  readonly config: Partial<RlmConfig>;
  /** "provider/id" of the pinned sub-LLM, or undefined for "cheapest (auto)".
   *  `null` = explicit "cheapest" clear (omit key on disk). */
  readonly llm?: string | null;
  /** "provider/id" of the pinned rlm root/worker model, or undefined for "follow session".
   *  `null` = explicit "follow session model" clear (omit key on disk). */
  readonly rlm?: string | null;
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

/**
 * Every value pi-ai accepts for `reasoning`. Keyed by the union so a new level added upstream
 * is a compile error here rather than a silently-rejected setting. Note `off` is NOT a
 * ThinkingLevel — a hand-edited rlm.json carrying one is dropped, not forwarded.
 */
const THINKING_LEVELS: Readonly<Record<ThinkingLevel, true>> = Object.freeze({
  minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
});

function validateThinkingLevel(v: unknown): ThinkingLevel | undefined {
  return typeof v === "string" && Object.hasOwn(THINKING_LEVELS, v) ? (v as ThinkingLevel) : undefined;
}

/** Validate an unknown (e.g. hand-edited rlm.json) config blob into a partial — the single
 *  validation seam; exported for tests. */
export function validateConfig(raw: unknown): Partial<RlmConfig> {
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
  const maxConcurrentChildren = validateNumber(r.maxConcurrentChildren, 1);
  if (maxConcurrentChildren !== undefined) out.maxConcurrentChildren = maxConcurrentChildren;
  const maxPromptChars = validateNumber(r.maxPromptChars, 1000);
  if (maxPromptChars !== undefined) out.maxPromptChars = maxPromptChars;
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
  const smartReasoning = validateThinkingLevel(r.smartReasoning);
  if (smartReasoning !== undefined) out.smartReasoning = smartReasoning;
  const subSystemPrompt = validateString(r.subSystemPrompt);
  if (subSystemPrompt !== undefined) out.subSystemPrompt = subSystemPrompt;
  const sandboxInitTimeoutMs = validateNumber(r.sandboxInitTimeoutMs, 100);
  if (sandboxInitTimeoutMs !== undefined) out.sandboxInitTimeoutMs = sandboxInitTimeoutMs;
  // `libraryLoader` is the pre-rename key — still read so an existing rlm.json survives the upgrade.
  const contextLoader = validateBoolean(r.contextLoader) ?? validateBoolean(r.libraryLoader);
  if (contextLoader !== undefined) out.contextLoader = contextLoader;
  const autoSeedCwd = validateBoolean(r.autoSeedCwd);
  if (autoSeedCwd !== undefined) out.autoSeedCwd = autoSeedCwd;
  // v5 token budget cascade
  const enableTokenBudget = validateBoolean(r.enableTokenBudget);
  if (enableTokenBudget !== undefined) out.enableTokenBudget = enableTokenBudget;
  const budgetShare = validateNumber(r.budgetShare, 0.01);
  if (budgetShare !== undefined && budgetShare <= 1) out.budgetShare = budgetShare;
  const budgetSoftFrac = validateNumber(r.budgetSoftFrac, 0.5);
  if (budgetSoftFrac !== undefined && budgetSoftFrac < 1) out.budgetSoftFrac = budgetSoftFrac;
  const budgetTaskCap = validateNumber(r.budgetTaskCap, 0);
  if (budgetTaskCap !== undefined) out.budgetTaskCap = budgetTaskCap;
  const budgetMaxContinuations = validateNumber(r.budgetMaxContinuations, 0);
  if (budgetMaxContinuations !== undefined) out.budgetMaxContinuations = budgetMaxContinuations;
  const budgetHandoffChars = validateNumber(r.budgetHandoffChars, 500);
  if (budgetHandoffChars !== undefined) out.budgetHandoffChars = budgetHandoffChars;
  // v5 TaskLedger blackboard
  const enableLedger = validateBoolean(r.enableLedger);
  if (enableLedger !== undefined) out.enableLedger = enableLedger;
  const rlmBudget = validateNumber(r.rlmBudget, 0);
  if (rlmBudget !== undefined) out.rlmBudget = rlmBudget;
  // v5 durable memory
  const enableMemory = validateBoolean(r.enableMemory);
  if (enableMemory !== undefined) out.enableMemory = enableMemory;
  const injectNoteTokens = validateNumber(r.injectNoteTokens, 100);
  if (injectNoteTokens !== undefined) out.injectNoteTokens = injectNoteTokens;
  const evolveEvery = validateNumber(r.evolveEvery, 0);
  if (evolveEvery !== undefined) out.evolveEvery = evolveEvery;
  if (r.memoryDir === null) out.memoryDir = null;
  else {
    const memoryDir = validateString(r.memoryDir);
    if (memoryDir !== undefined) out.memoryDir = memoryDir;
  }
  // v5 provider concurrency caps: { provider: minConcurrent }
  if (typeof r.providerMaxConcurrent === "object" && r.providerMaxConcurrent !== null) {
    const caps: Record<string, number> = {};
    for (const [provider, cap] of Object.entries(r.providerMaxConcurrent as Record<string, unknown>)) {
      const n = validateNumber(cap, 1);
      if (n !== undefined) caps[provider] = n;
    }
    if (Object.keys(caps).length > 0) out.providerMaxConcurrent = Object.freeze(caps);
  }
  // v5 child surface doctrine
  if (r.childSurface === "delegation" || r.childSurface === "legacy") out.childSurface = r.childSurface;
  if (typeof r.subSampling === "object" && r.subSampling !== null) {
    const ss = r.subSampling as Record<string, unknown>;
    const sampling: { maxTokens?: number; temperature?: number; reasoning?: ThinkingLevel } = {};
    const maxTokensValue = validateNumber(ss.maxTokens, 1);
    if (maxTokensValue !== undefined) sampling.maxTokens = maxTokensValue;
    const temperature = validateNumber(ss.temperature, 0);
    if (temperature !== undefined) sampling.temperature = temperature;
    const ssReasoning = validateThinkingLevel(ss.reasoning);
    if (ssReasoning !== undefined) sampling.reasoning = ssReasoning;
    out.subSampling = Object.freeze(sampling);
  }
  if (typeof r.rootSampling === "object" && r.rootSampling !== null) {
    const rs = r.rootSampling as Record<string, unknown>;
    const rootSampling: { maxTokens?: number; temperature?: number; reasoning?: ThinkingLevel } = {};
    const rsMaxTokens = validateNumber(rs.maxTokens, 1);
    if (rsMaxTokens !== undefined) rootSampling.maxTokens = rsMaxTokens;
    const rsTemperature = validateNumber(rs.temperature, 0);
    if (rsTemperature !== undefined) rootSampling.temperature = rsTemperature;
    const rsReasoning = validateThinkingLevel(rs.reasoning);
    if (rsReasoning !== undefined) rootSampling.reasoning = rsReasoning;
    out.rootSampling = Object.freeze(rootSampling);
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
      // `worker` is the pre-rename key — still read so an existing pin survives the upgrade.
      llm: validateString(r.llm) ?? validateString(r.worker),
      rlm: validateString(r.rlm),
    };
  } catch {
    return { config: {} };
  }
}

export async function saveSettings(s: PersistedSettings): Promise<boolean> {
  try {
    const p = settingsPath();
    await mkdir(dirname(p), { recursive: true });
    const body: Record<string, unknown> = { config: s.config };
    const mergeDisk = s.llm === undefined || s.rlm === undefined;
    const existing = mergeDisk ? await loadSettings() : undefined;
    if (s.llm !== undefined) {
      // Explicit: string → write pin, null → omit key (cheapest).
      if (s.llm !== null) body.llm = s.llm;
    } else if (existing?.llm) {
      // Merge: preserve existing disk pin so config-only saves never strip it.
      body.llm = existing.llm;
    }
    if (s.rlm !== undefined) {
      if (s.rlm !== null) body.rlm = s.rlm;
    } else if (existing?.rlm) {
      body.rlm = existing.rlm;
    }
    await writeFile(p, `${JSON.stringify(body, null, 2)}\n`);
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
    rootSampling: Object.freeze({ ...DEFAULT_CONFIG.rootSampling, ...partial.rootSampling }),
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

/**
 * Human-readable "provider/id" for a sub-call node: the resolved override when one was
 * supplied and resolves, otherwise the fallback model. Shared by the llm and rlm bridges
 * so sub-call trees label their nodes identically.
 */
export function displayModelRef(
  registry: ModelRegistry,
  override: string | null,
  fallback: Model<Api>,
): string {
  const resolved = override ? (resolveModelId(registry, override) ?? fallback) : fallback;
  return modelRef(resolved) ?? fallback.id;
}
