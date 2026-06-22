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
import type { RlmConfig } from "../core/types.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

export interface PersistedSettings {
  config: Partial<RlmConfig>;
  smart?: string; // "provider/id"
  worker?: string;
}

function settingsPath(): string {
  return join(getAgentDir(), "rlm.json");
}

export function loadSettings(): PersistedSettings {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as PersistedSettings;
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
