/**
 * Config panel TUI — toggle RLM run parameters (depth, iterations, timeout, concurrency,
 * orchestrator) via pi's `SettingsList`. Mutates the live RlmConfig in place.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { RlmConfig } from "../core/types.ts";

const CHOICES = {
  maxDepth: ["1", "2", "3", "4"],
  maxIterations: ["10", "20", "30", "50"],
  execTimeoutS: ["30", "60", "120", "300"],
  maxConcurrentSubcalls: ["2", "4", "8", "16"],
  maxBudgetUsd: ["none", "0.50", "1", "5"],
  maxTimeoutMs: ["none", "60", "120", "300"],
  maxTokens: ["none", "10000", "50000", "100000"],
  maxErrors: ["3", "5", "10", "none"],
  orchestrator: ["on", "off"],
  compaction: ["on", "off"],
};

export async function showConfigPanel(ctx: ExtensionContext, config: RlmConfig): Promise<void> {
  if (ctx.mode !== "tui") return;
  const items: SettingItem[] = [
    { id: "maxDepth", label: "Max recursion depth", currentValue: String(config.maxDepth), values: CHOICES.maxDepth },
    { id: "maxIterations", label: "Max iterations", currentValue: String(config.maxIterations), values: CHOICES.maxIterations },
    { id: "execTimeoutS", label: "REPL block timeout (s)", currentValue: String(config.execTimeoutS), values: CHOICES.execTimeoutS },
    { id: "maxConcurrentSubcalls", label: "Max concurrent sub-calls", currentValue: String(config.maxConcurrentSubcalls), values: CHOICES.maxConcurrentSubcalls },
    { id: "maxBudgetUsd", label: "Budget ceiling (USD)", currentValue: config.maxBudgetUsd != null ? String(config.maxBudgetUsd) : "none", values: CHOICES.maxBudgetUsd },
    { id: "maxTimeoutMs", label: "Wall-clock ceiling (min)", currentValue: config.maxTimeoutMs != null ? String(Math.round(config.maxTimeoutMs / 60_000)) : "none", values: CHOICES.maxTimeoutMs },
    { id: "maxTokens", label: "Token ceiling", currentValue: config.maxTokens != null ? String(config.maxTokens) : "none", values: CHOICES.maxTokens },
    { id: "maxErrors", label: "Max consecutive errors", currentValue: config.maxErrors != null ? String(config.maxErrors) : "none", values: CHOICES.maxErrors },
    { id: "orchestrator", label: "Orchestrator addendum", currentValue: config.orchestrator ? "on" : "off", values: CHOICES.orchestrator },
    { id: "compaction", label: "Trajectory compaction", currentValue: config.compaction ? "on" : "off", values: CHOICES.compaction },
  ];

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("RLM settings")), 1, 1));
    const list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, value) => applySetting(config, id, value),
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
}

function applySetting(config: RlmConfig, id: string, value: string): void {
  switch (id) {
    case "maxDepth":
      config.maxDepth = Number(value);
      break;
    case "maxIterations":
      config.maxIterations = Number(value);
      break;
    case "execTimeoutS":
      config.execTimeoutS = Number(value);
      break;
    case "maxConcurrentSubcalls":
      config.maxConcurrentSubcalls = Number(value);
      break;
    case "maxBudgetUsd":
      config.maxBudgetUsd = value === "none" ? undefined : Number(value);
      break;
    case "maxTimeoutMs":
      config.maxTimeoutMs = value === "none" ? undefined : Number(value) * 60_000;
      break;
    case "maxTokens":
      config.maxTokens = value === "none" ? undefined : Number(value);
      break;
    case "maxErrors":
      config.maxErrors = value === "none" ? undefined : Number(value);
      break;
    case "orchestrator":
      config.orchestrator = value === "on";
      break;
    case "compaction":
      config.compaction = value === "on";
      break;
  }
}
