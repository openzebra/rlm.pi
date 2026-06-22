/** Model picker TUI — choose a model and, when supported, a thinking level. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { formatCost } from "./theme.ts";

export interface ModelSelection {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type SelectableThinkingLevel = (typeof LEVELS)[number];

function items(models: Model<Api>[]): SelectItem[] {
  return models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.id}`,
    description: `in ${formatCost(m.cost.input)}/Mtok · out ${formatCost(m.cost.output)}/Mtok${m.reasoning ? " · reasoning" : ""}`,
  }));
}

function supportedThinkingLevels(model: Model<Api>): SelectableThinkingLevel[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (!map) return [...LEVELS];
  return LEVELS.filter((level) => map[level] !== null);
}

async function selectThinkingLevel(
  ctx: ExtensionContext,
  model: Model<Api>,
  current?: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  const levels = supportedThinkingLevels(model);
  if (levels.length === 0) return undefined;
  if (ctx.mode !== "tui") {
    const level = current ?? levels[0];
    return level === "off" ? undefined : level;
  }

  const chosen = await ctx.ui.custom<SelectableThinkingLevel | null>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Thinking level")), 1, 0));
    const list = new SelectList(
      levels.map((level) => ({ value: level, label: level, description: `Use ${level} reasoning for ${model.id}` })),
      levels.length,
      {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    );
    const initial = levels.indexOf(current ?? "off");
    if (initial >= 0) list.setSelectedIndex(initial);
    list.onSelect = (item) => done(item.value as SelectableThinkingLevel);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc skip"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return { render: (w) => container.render(w), invalidate: () => container.invalidate(), handleInput: (data) => list.handleInput(data) };
  });
  return chosen === "off" ? undefined : (chosen ?? undefined);
}

/** Show a model selector; resolves to the chosen model plus optional thinking level. */
export async function selectModel(
  ctx: ExtensionContext,
  title: string,
  models: Model<Api>[],
  current?: Model<Api>,
  currentThinking?: ThinkingLevel,
): Promise<ModelSelection | undefined> {
  if (models.length === 0) {
    ctx.ui.notify("RLM: no models with configured auth", "warning");
    return undefined;
  }
  if (ctx.mode !== "tui") {
    const model = current ?? models[0]!;
    return { model, thinkingLevel: await selectThinkingLevel(ctx, model, currentThinking) };
  }

  const chosen = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items(models), Math.min(models.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return { render: (w) => container.render(w), invalidate: () => container.invalidate(), handleInput: (data) => list.handleInput(data) };
  });

  const model = chosen ? models.find((m) => `${m.provider}/${m.id}` === chosen) : undefined;
  if (!model) return undefined;
  return { model, thinkingLevel: await selectThinkingLevel(ctx, model, currentThinking) };
}
