/** Model picker TUI — choose a model and, when supported, a thinking level. */

import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Container, type Component, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatCost } from "./theme.ts";
import { compareLlm } from "../mode/llm-model.ts";

export interface ModelSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type SelectableThinkingLevel = (typeof LEVELS)[number];

const CHEAPEST_VALUE = "__rlm_cheapest__";

/**
 * Models Pi itself would offer for this session, cheapest-first.
 *
 * Mirrors the built-in model switcher:
 *   - if the session has scoped models (`--models` / enabledModels) → those only
 *   - else → `getAvailable()` (providers with configured auth)
 *
 * Deliberately NOT `getAll()`: the full catalog dumps every provider's catalog entry and is
 * not what the user sees in Pi natively. See Pi extension docs on `ctx.scopedModels`.
 */
export function pickableModels(
  registry: ModelRegistry,
  scoped?: readonly { readonly model: Model<Api> }[],
): readonly Model<Api>[] {
  const source = scoped !== undefined && scoped.length > 0
    ? scoped.map((s) => s.model)
    : registry.getAvailable();
  return [...source].sort(compareLlm);
}

function items(models: readonly Model<Api>[], includeCheapest: boolean): SelectItem[] {
  const modelItems = models.map((m) => {
    const price = `in ${formatCost(m.cost.input)}/Mtok · out ${formatCost(m.cost.output)}/Mtok`;
    return {
      value: `${m.provider}/${m.id}`,
      label: `${m.provider}/${m.id}`,
      description: `${price}${m.reasoning ? " · reasoning" : ""}`,
    };
  });
  if (!includeCheapest) return modelItems;
  return [
    { value: CHEAPEST_VALUE, label: "⟳ cheapest (auto)", description: "Always use the cheapest model with a configured key" },
    ...modelItems,
  ];
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
  models: readonly Model<Api>[],
  current?: Model<Api>,
  currentThinking?: ThinkingLevel,
): Promise<ModelSelection | null | undefined> {
  if (models.length === 0) {
    ctx.ui.notify("RLM: no models available (add a provider key in Pi, or widen --models / enabledModels)", "warning");
    return undefined;
  }
  if (ctx.mode !== "tui") {
    const fallback = models[0];
    if (!fallback) return undefined;
    const model = current ?? fallback;
    return { model, thinkingLevel: await selectThinkingLevel(ctx, model, currentThinking) };
  }

  const chosen = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
    let query = "";
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const filterLine: Component = {
      render: (w) => [truncateToWidth(theme.fg("dim", `Filter: ${query || "type to filter…"}`), w)],
      invalidate: () => {},
    };
    const list = new SelectList(items(models, true), Math.min(models.length + 1, 13), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    const isFilterText = (s: string): boolean => {
      const sanitized = s.replace(/ /g, "");
      return sanitized.length > 0 && Array.from(sanitized).every((char) => char >= " " && char !== "\x7f");
    };
    const isBackspace = (s: string): boolean => s === "\x7f" || s === "\b";
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(filterLine);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (isFilterText(data)) {
          query = `${query}${data.replace(/ /g, "")}`;
          list.setFilter(query);
          return;
        }
        if (isBackspace(data)) {
          query = query.slice(0, -1);
          list.setFilter(query);
          return;
        }
        list.handleInput(data);
      },
    };
  });

  if (chosen === CHEAPEST_VALUE) return null;
  const model = chosen ? models.find((m) => `${m.provider}/${m.id}` === chosen) : undefined;
  if (!model) return undefined;
  return { model, thinkingLevel: await selectThinkingLevel(ctx, model, currentThinking) };
}
