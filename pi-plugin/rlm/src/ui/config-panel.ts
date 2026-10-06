/** Config panel TUI — toggle RLM run parameters with descriptions. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { DISPLAY_LOCALES, type RlmConfig } from "../core/types.ts";
import { THINKING_LEVELS } from "../config/settings.ts";
import { setDisplayLocale, sigmaStrings, type PanelKey } from "../ui/sigma-i18n.ts";

const CHOICES = Object.freeze({
  displayLocale: DISPLAY_LOCALES,
  maxDepth: Object.freeze(["1", "2", "3", "4"]),
  maxIterations: Object.freeze(["100", "200", "500", "1000"]),
  execTimeoutS: Object.freeze(["30", "60", "120", "300"]),
  maxConcurrentSubcalls: Object.freeze(["2", "4", "8", "16", "32"]),
  maxConcurrentChildren: Object.freeze(["1", "2", "3", "4", "6", "8"]),
  maxTimeoutMs: Object.freeze(["none", "60", "120", "300"]),
  maxTokens: Object.freeze(["none", "10000", "50000", "100000"]),
  maxErrors: Object.freeze(["3", "5", "10", "none"]),
  orchestrator: Object.freeze(["on", "off"]),
  compaction: Object.freeze(["on", "off"]),
  compactionThresholdPct: Object.freeze(["50", "65", "80", "90"]),
  rootSamplingMaxTokens: Object.freeze(["4096", "8192", "16384", "32768"]),
  smartReasoning: Object.freeze(["default", ...Object.keys(THINKING_LEVELS)]),
  subSamplingMaxTokens: Object.freeze(["1024", "2048", "4096", "8192"]),
  subSamplingTemperature: Object.freeze(["0", "0.3", "0.7", "1.0", "default"]),
  sandboxInitTimeoutMs: Object.freeze(["10000", "30000", "60000", "120000"]),
  requestTimeoutMs: Object.freeze(["2", "5", "10", "15", "20"]),
  contextLoader: Object.freeze(["on", "off"]),
  autoSeedCwd: Object.freeze(["on", "off"]),
});

function item(id: PanelKey, currentValue: string, values: readonly string[]): SettingItem {
  // Label and description come ONLY from the locale table (one wording source — no inline
  // English literals to drift). Resolved per render so a displayLocale save re-localizes live.
  const s = sigmaStrings();
  return { id, label: s.panel.labels[id], currentValue, values: [...values], description: s.descriptions[id] };
}

/**
 * Show the settings panel and resolve with the edited config.
 * `config` is never mutated — each change produces a new frozen object.
 */
export async function showConfigPanel(ctx: ExtensionContext, config: RlmConfig): Promise<RlmConfig> {
  if (ctx.mode !== "tui") return config;
  let edited = config;
  const items: SettingItem[] = [
    item("maxDepth", String(config.maxDepth), CHOICES.maxDepth),
    item("maxIterations", String(config.maxIterations), CHOICES.maxIterations),
    item("execTimeoutS", String(config.execTimeoutS), CHOICES.execTimeoutS),
    item("maxConcurrentSubcalls", String(config.maxConcurrentSubcalls), CHOICES.maxConcurrentSubcalls),
    item("maxConcurrentChildren", String(config.maxConcurrentChildren), CHOICES.maxConcurrentChildren),
    item("maxTimeoutMs", config.maxTimeoutMs != null ? String(Math.round(config.maxTimeoutMs / 60_000)) : "none", CHOICES.maxTimeoutMs),
    item("maxTokens", config.maxTokens != null ? String(config.maxTokens) : "none", CHOICES.maxTokens),
    item("maxErrors", config.maxErrors != null ? String(config.maxErrors) : "none", CHOICES.maxErrors),
    item("orchestrator", config.orchestrator ? "on" : "off", CHOICES.orchestrator),
    item("compaction", config.compaction ? "on" : "off", CHOICES.compaction),
    item("compactionThresholdPct", String(Math.round(config.compactionThresholdPct * 100)), CHOICES.compactionThresholdPct),
    item("rootSamplingMaxTokens", String(config.rootSampling?.maxTokens ?? 16384), CHOICES.rootSamplingMaxTokens),
    item("smartReasoning", config.smartReasoning ?? "default", CHOICES.smartReasoning),
    item("subSamplingMaxTokens", String(config.subSampling?.maxTokens ?? 8192), CHOICES.subSamplingMaxTokens),
    item("subSamplingTemperature", config.subSampling?.temperature === undefined ? "default" : String(config.subSampling?.temperature), CHOICES.subSamplingTemperature),
    item("sandboxInitTimeoutMs", String(config.sandboxInitTimeoutMs), CHOICES.sandboxInitTimeoutMs),
    item("requestTimeoutMs", String(Math.round(config.requestTimeoutMs / 60_000)), CHOICES.requestTimeoutMs),
    item("contextLoader", config.contextLoader ? "on" : "off", CHOICES.contextLoader),
    item("autoSeedCwd", config.autoSeedCwd ? "on" : "off", CHOICES.autoSeedCwd),
    item("displayLocale", config.displayLocale, CHOICES.displayLocale),
    // R5: the window calibrations are rlm.json-only knobs — shown read-only with live values.
    item("__sigma_window__",
      `keepTurns=${config.rootContextKeepTurns} · elide=${config.rootContextElideChars} · snapshot=${config.rootContextSnapshot ? "on" : "off"} · archive=${config.rootArchiveMaxChars > 0 ? `${Math.round(config.rootArchiveMaxChars / 1000)}k` : "off"}`,
      ["rlm.json"]),
    item("__save__", "↵", ["↵"]),
  ];

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(sigmaStrings().panel.title)), 1, 1));
    const list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, value) => {
        if (id === "__save__") {
          done();
          return;
        }
        edited = applySetting(edited, id, value);
      },
      () => done(),
    );
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", sigmaStrings().panel.hint), 1, 1));
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => list.handleInput?.(data),
    };
  });
  return edited;
}

/** Optional numeric field: the literal "none" clears it. */
function optionalNumber(value: string, scale = 1): number | undefined {
  return value === "none" ? undefined : Number(value) * scale;
}

/** Optional temperature: the literal "default" clears it (provider default); else [0, 2]. */
function optionalTemperature(value: string): number | undefined {
  if (value === "default") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
}

/** Pure: returns a new frozen config with `id` set to `value`; unknown ids pass through. */
export function applySetting(config: RlmConfig, id: string, value: string): RlmConfig {
  switch (id) {
    case "maxDepth": return Object.freeze({ ...config, maxDepth: Number(value) });
    case "maxIterations": return Object.freeze({ ...config, maxIterations: Number(value) });
    case "execTimeoutS": return Object.freeze({ ...config, execTimeoutS: Number(value) });
    case "maxConcurrentSubcalls": return Object.freeze({ ...config, maxConcurrentSubcalls: Number(value) });
    case "maxConcurrentChildren": return Object.freeze({ ...config, maxConcurrentChildren: Number(value) });
    case "maxTimeoutMs": return Object.freeze({ ...config, maxTimeoutMs: optionalNumber(value, 60_000) });
    case "maxTokens": return Object.freeze({ ...config, maxTokens: optionalNumber(value) });
    case "maxErrors": return Object.freeze({ ...config, maxErrors: optionalNumber(value) });
    case "orchestrator": return Object.freeze({ ...config, orchestrator: value === "on" });
    case "compaction": return Object.freeze({ ...config, compaction: value === "on" });
    case "compactionThresholdPct": return Object.freeze({ ...config, compactionThresholdPct: Number(value) / 100 });
    case "rootSamplingMaxTokens":
      return Object.freeze({ ...config, rootSampling: Object.freeze({ ...config.rootSampling, maxTokens: Number(value) }) });
    case "smartReasoning":
      if (value === "default") return Object.freeze({ ...config, smartReasoning: undefined });
      return Object.hasOwn(THINKING_LEVELS, value)
        ? Object.freeze({ ...config, smartReasoning: value as ThinkingLevel })
        : config;
    case "subSamplingMaxTokens":
      return Object.freeze({ ...config, subSampling: Object.freeze({ ...config.subSampling, maxTokens: Number(value) }) });
    case "subSamplingTemperature": {
      const st = optionalTemperature(value);
      if (st === undefined && value !== "default") return config;
      return Object.freeze({ ...config, subSampling: Object.freeze({ ...config.subSampling, temperature: st }) });
    }
    case "sandboxInitTimeoutMs": return Object.freeze({ ...config, sandboxInitTimeoutMs: Number(value) });
    case "requestTimeoutMs": return Object.freeze({ ...config, requestTimeoutMs: Number(value) * 60_000 });
    case "contextLoader": return Object.freeze({ ...config, contextLoader: value === "on" });
    case "autoSeedCwd": return Object.freeze({ ...config, autoSeedCwd: value === "on" });
    case "displayLocale": {
      const locale = DISPLAY_LOCALES.find((l) => l === value);
      if (locale === undefined) return config;
      setDisplayLocale(locale);
      return Object.freeze({ ...config, displayLocale: locale });
    }
    default: return config;
  }
}
