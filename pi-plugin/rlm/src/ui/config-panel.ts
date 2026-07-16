/** Config panel TUI — toggle RLM run parameters with descriptions. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { RlmConfig } from "../core/types.ts";

const CHOICES = Object.freeze({
  maxDepth: Object.freeze(["1", "2", "3", "4"]),
  maxIterations: Object.freeze(["10", "20", "30", "50"]),
  execTimeoutS: Object.freeze(["30", "60", "120", "300"]),
  maxConcurrentSubcalls: Object.freeze(["2", "4", "8", "16"]),
  maxBudgetUsd: Object.freeze(["none", "0.50", "1", "5"]),
  maxTimeoutMs: Object.freeze(["none", "60", "120", "300"]),
  maxTokens: Object.freeze(["none", "10000", "50000", "100000"]),
  maxErrors: Object.freeze(["3", "5", "10", "none"]),
  orchestrator: Object.freeze(["on", "off"]),
  pipeline: Object.freeze(["on", "off"]),
  maxBackwardJumps: Object.freeze(["0", "1", "2", "3"]),
  compaction: Object.freeze(["on", "off"]),
  rootSamplingMaxTokens: Object.freeze(["4096", "8192", "16384", "32768"]),
  sandboxInitTimeoutMs: Object.freeze(["10000", "30000", "60000", "120000"]),
  askUserQuestion: Object.freeze(["on", "off"]),
  todo: Object.freeze(["on", "off"]),
});

function item(id: string, label: string, currentValue: string, values: readonly string[], description: string): SettingItem {
  return { id, label, currentValue, values: [...values], description };
}

export async function showConfigPanel(ctx: ExtensionContext, config: RlmConfig): Promise<void> {
  if (ctx.mode !== "tui") return;
  const items: SettingItem[] = [
    item("maxDepth", "Max recursion depth", String(config.maxDepth), CHOICES.maxDepth, "rlm_query past this depth degrades to plain llm_query (1 = no recursion)."),
    item("maxIterations", "Max iterations", String(config.maxIterations), CHOICES.maxIterations, "Maximum root REPL turns before RLM asks the model for a final answer."),
    item("execTimeoutS", "REPL block timeout (s)", String(config.execTimeoutS), CHOICES.execTimeoutS, "Wall-clock limit for one model-authored Python REPL block."),
    item("maxConcurrentSubcalls", "Max concurrent sub-calls", String(config.maxConcurrentSubcalls), CHOICES.maxConcurrentSubcalls, "Concurrency pool size for llm_query_batched and rlm_query_batched."),
    item("maxBudgetUsd", "Budget ceiling (USD)", config.maxBudgetUsd != null ? String(config.maxBudgetUsd) : "none", CHOICES.maxBudgetUsd, "Total spend cap for the whole recursive tree; none disables the cap."),
    item("maxTimeoutMs", "Wall-clock ceiling (min)", config.maxTimeoutMs != null ? String(Math.round(config.maxTimeoutMs / 60_000)) : "none", CHOICES.maxTimeoutMs, "Total runtime cap for the whole recursive tree; none disables the cap."),
    item("maxTokens", "Token ceiling", config.maxTokens != null ? String(config.maxTokens) : "none", CHOICES.maxTokens, "Total input+output token cap for the whole recursive tree."),
    item("maxErrors", "Max consecutive errors", config.maxErrors != null ? String(config.maxErrors) : "none", CHOICES.maxErrors, "Stop after this many consecutive failing turns; none disables the guard."),
    item("orchestrator", "Orchestrator addendum", config.orchestrator ? "on" : "off", CHOICES.orchestrator, "Append extra divide-and-conquer guidance to the root model system prompt."),
    item("pipeline", "Phase pipeline", config.pipeline ? "on" : "off", CHOICES.pipeline, "Enable artifact-gated phases: research→blueprint→implement fanout→validate."),
    item("maxBackwardJumps", "Max validate→blueprint loops", String(config.maxBackwardJumps), CHOICES.maxBackwardJumps, "Bounded corrective re-entries when validation reports blockers_count > 0."),
    item("compaction", "Trajectory compaction", config.compaction ? "on" : "off", CHOICES.compaction, "Summarize old turns when history approaches the model context window."),
    item("rootSamplingMaxTokens", "Root model output cap (tok)", String(config.rootSampling?.maxTokens ?? 16384), CHOICES.rootSamplingMaxTokens, "Max output tokens per root-model turn. Lower values keep each turn lean."),
    item("sandboxInitTimeoutMs", "Sandbox init timeout", String(config.sandboxInitTimeoutMs), CHOICES.sandboxInitTimeoutMs, "How long to wait for the Python worker to start."),
    item("askUserQuestion", "[Interactive] Ask user", config.askUserQuestion ? "on" : "off", CHOICES.askUserQuestion, "Allow root REPL code to present structured ask_user_question dialogs."),
    item("todo", "[Interactive] Todo", config.todo ? "on" : "off", CHOICES.todo, "Allow REPL code to manage a visible todo task list."),
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
        applySetting(config, id, value);
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
}

function applySetting(config: RlmConfig, id: string, value: string): void {
  switch (id) {
    case "maxDepth": config.maxDepth = Number(value); break;
    case "maxIterations": config.maxIterations = Number(value); break;
    case "execTimeoutS": config.execTimeoutS = Number(value); break;
    case "maxConcurrentSubcalls": config.maxConcurrentSubcalls = Number(value); break;
    case "maxBudgetUsd": config.maxBudgetUsd = value === "none" ? undefined : Number(value); break;
    case "maxTimeoutMs": config.maxTimeoutMs = value === "none" ? undefined : Number(value) * 60_000; break;
    case "maxTokens": config.maxTokens = value === "none" ? undefined : Number(value); break;
    case "maxErrors": config.maxErrors = value === "none" ? undefined : Number(value); break;
    case "orchestrator": config.orchestrator = value === "on"; break;
    case "pipeline": config.pipeline = value === "on"; break;
    case "maxBackwardJumps": config.maxBackwardJumps = Number(value); break;
    case "compaction": config.compaction = value === "on"; break;
    case "rootSamplingMaxTokens": config.rootSampling = Object.freeze({ ...config.rootSampling, maxTokens: Number(value) }); break;
    case "sandboxInitTimeoutMs": config.sandboxInitTimeoutMs = Number(value); break;
    case "askUserQuestion": config.askUserQuestion = value === "on"; break;
    case "todo": config.todo = value === "on"; break;
  }
}
