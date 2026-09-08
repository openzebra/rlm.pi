/** Config panel TUI — toggle RLM run parameters with descriptions. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { RlmConfig } from "../core/types.ts";
import { THINKING_LEVELS } from "../config/settings.ts";

const CHOICES = Object.freeze({
  maxDepth: Object.freeze(["1", "2", "3", "4"]),
  maxIterations: Object.freeze(["10", "20", "30", "50"]),
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
  rootSamplingTemperature: Object.freeze(["0", "0.3", "0.7", "1.0", "default"]),
  smartReasoning: Object.freeze(["default", ...Object.keys(THINKING_LEVELS)]),
  subSamplingMaxTokens: Object.freeze(["1024", "2048", "4096", "8192"]),
  subSamplingTemperature: Object.freeze(["0", "0.3", "0.7", "1.0", "default"]),
  sandboxInitTimeoutMs: Object.freeze(["10000", "30000", "60000", "120000"]),
  requestTimeoutMs: Object.freeze(["2", "5", "10", "15", "20"]),
  contextLoader: Object.freeze(["on", "off"]),
  autoSeedCwd: Object.freeze(["on", "off"]),
});

function item(id: string, label: string, currentValue: string, values: readonly string[], description: string): SettingItem {
  return { id, label, currentValue, values: [...values], description };
}

/**
 * Show the settings panel and resolve with the edited config.
 * `config` is never mutated — each change produces a new frozen object.
 */
export async function showConfigPanel(ctx: ExtensionContext, config: RlmConfig): Promise<RlmConfig> {
  if (ctx.mode !== "tui") return config;
  let edited = config;
  const items: SettingItem[] = [
    item("maxDepth", "Max recursion depth", String(config.maxDepth), CHOICES.maxDepth, "rlm_query past this depth degrades to plain llm_query (1 = no recursion)."),
    item("maxIterations", "Max iterations", String(config.maxIterations), CHOICES.maxIterations, "Maximum root REPL turns before RLM asks the model for a final answer."),
    item("execTimeoutS", "REPL block timeout (s)", String(config.execTimeoutS), CHOICES.execTimeoutS, "Wall-clock limit for one model-authored Python REPL block."),
    item("maxConcurrentSubcalls", "Max concurrent sub-calls", String(config.maxConcurrentSubcalls), CHOICES.maxConcurrentSubcalls, "Concurrency pool size for llm_batch and rlm_batch."),
    item("maxConcurrentChildren", "Max concurrent children", String(config.maxConcurrentChildren), CHOICES.maxConcurrentChildren, "Concurrent rlm_query child engines per depth. Each is a Python process holding its own copy of the inherited context."),
    item("maxTimeoutMs", "Wall-clock ceiling (min)", config.maxTimeoutMs != null ? String(Math.round(config.maxTimeoutMs / 60_000)) : "none", CHOICES.maxTimeoutMs, "Total runtime cap for the whole recursive tree; none disables the cap."),
    item("maxTokens", "Token ceiling", config.maxTokens != null ? String(config.maxTokens) : "none", CHOICES.maxTokens, "Total input+output token cap for the whole recursive tree."),
    item("maxErrors", "Max consecutive errors", config.maxErrors != null ? String(config.maxErrors) : "none", CHOICES.maxErrors, "Stop after this many consecutive failing turns; none disables the guard."),
    item("orchestrator", "Orchestrator addendum", config.orchestrator ? "on" : "off", CHOICES.orchestrator, "Append extra divide-and-conquer guidance to the root model system prompt."),
    item("compaction", "Trajectory compaction", config.compaction ? "on" : "off", CHOICES.compaction, "Summarize old turns when history approaches the model context window."),
    item("compactionThresholdPct", "Compaction threshold (%)", String(Math.round(config.compactionThresholdPct * 100)), CHOICES.compactionThresholdPct, "DEPRECATED — ignored: compaction uses the absolute 256k ceiling (COMPACTION_CEILING_TOKENS)."),
    item("rootSamplingMaxTokens", "Root model output cap (tok)", String(config.rootSampling?.maxTokens ?? 16384), CHOICES.rootSamplingMaxTokens, "Max output tokens per root-model turn. Lower values keep each turn lean."),
    item("rootSamplingTemperature", "Root sampling temperature", config.rootSampling?.temperature === undefined ? "default" : String(config.rootSampling?.temperature), CHOICES.rootSamplingTemperature,
      "Sampling temperature for RLM root turns, finalize included — 0 = deterministic (the r3 reproducibility setting); 'default' = provider default. Applies to RLM-mode runs, rlm() delegation and child recursion; the native Pi agent loop follows Pi's own session settings."),
    item("smartReasoning", "Root reasoning effort", config.smartReasoning ?? "default", CHOICES.smartReasoning,
      "Thinking effort for the root model ('default' = none). Only models whose registry entry supports reasoning will think; others silently run without it. Reasoning tokens share the output cap — raise the root output cap when thinking is on."),
    item("subSamplingMaxTokens", "Worker output cap (tok)", String(config.subSampling?.maxTokens ?? 8192), CHOICES.subSamplingMaxTokens,
      "Max output tokens per leaf sub-call (llm_query / llm_batch / map_files)."),
    item("subSamplingTemperature", "Worker sampling temperature", config.subSampling?.temperature === undefined ? "default" : String(config.subSampling?.temperature), CHOICES.subSamplingTemperature,
      "Sampling temperature for leaf sub-calls; 'default' = provider default. Deterministic extraction (temp 0) is what made the r3 bench stable."),
    item("sandboxInitTimeoutMs", "Sandbox init timeout", String(config.sandboxInitTimeoutMs), CHOICES.sandboxInitTimeoutMs, "How long to wait for the Python worker to start."),
    item("requestTimeoutMs", "Sandbox request timeout (min)", String(Math.round(config.requestTimeoutMs / 60_000)), CHOICES.requestTimeoutMs, "Parent-side watchdog per sandbox request; on breach the Python worker is killed."),
    item("contextLoader", "Context loader", config.contextLoader ? "on" : "off", CHOICES.contextLoader,
      "Allow add_context() to pull an external dir, file, document, or git repo into context."),
    item("autoSeedCwd", "Auto-seed cwd", config.autoSeedCwd ? "on" : "off", CHOICES.autoSeedCwd,
      "Seed the working directory into context on the first repl() call (otherwise starts empty)."),
    // R0 (/tmp/ROOT_FULL_SKILLSTATE_PLAN.md): the SKILL.state / Root Σ paradigm flags are
    // ENFORCED — rendered as a read-only badge so the truth is visible instead of hidden.
    // No toggle exists: applySetting has no case for them and the validator forces true.
    item("__sigma_enforced__", "SKILL.state / Root Σ", "enforced", ["enforced"],
      "ENFORCED (no opt-out): run state, skill state + distill, root context transform, state fences, digest compaction. " +
        "Override attempts in rlm.json are traced (skillstate.override-ignored) and ignored; RLM_BENCH_NO_ROOTCONTEXT=1 is the dev-only measurement hatch."),
    // R5: the window calibrations are rlm.json-only knobs — shown read-only with live values.
    item("__sigma_window__", "Root Σ window (calibration)",
      `keepTurns=${config.rootContextKeepTurns} · elide=${config.rootContextElideChars} · snapshot=${config.rootContextSnapshot ? "on" : "off"}`,
      ["rlm.json"],
      "Query-time window calibrations, rlm.json only: rootContextKeepTurns (1 = strict: Σ + current turn; 2 = default), rootContextElideChars, rootContextSnapshot. " +
        "Session resume/fork: the tracker is reborn lazily and Σ re-grows from live observations — the first call after a resume has an empty Σ by design."),
    item("__save__", "Save & close", "↵", ["↵"], "Save these settings and close (Esc also saves)."),
  ];

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("RLM settings")), 1, 1));
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
    container.addChild(new Text(theme.fg("dim", "↑↓ move · enter change · esc save & close"), 1, 1));
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
    case "rootSamplingTemperature": {
      const t = optionalTemperature(value);
      // Reject invalid values (NaN / out of range) — keep the current setting.
      if (t === undefined && value !== "default") return config;
      return Object.freeze({ ...config, rootSampling: Object.freeze({ ...config.rootSampling, temperature: t }) });
    }
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
    default: return config;
  }
}
