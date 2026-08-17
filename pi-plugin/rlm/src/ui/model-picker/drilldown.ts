/**
 * drilldown — the grouped model picker: provider → model → thinking level.
 *
 * Three sequential pi overlays, one per level; SelectList has no native groups,
 * so grouping is navigation instead of headers. Every level gets a "← back"
 * row; esc cancels the whole flow. Level 3 (thinking level) is skipped for
 * models that support none.
 *
 * Roles differ only in the level-1 sentinel row:
 *   llm → "(cheapest, auto)"     — always the cheapest configured model
 *   rlm → "(follow session model)" — child engines track pi's active model
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Container, type Component, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { CHEAPEST_VALUE, SESSION_VALUE, buildCatalog, modelRefOf, type ProviderGroup } from "./grouping.ts";
import { selectThinkingLevel, supportedThinkingLevels } from "./levels.ts";

export type PickerRole = "llm" | "rlm";

export interface ModelSelection {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
}

const BACK_VALUE = "__rlm_back__";
const MAX_VISIBLE = 13;

const TOP_OPTIONS: Readonly<Record<PickerRole, SelectItem>> = Object.freeze({
  llm: { value: CHEAPEST_VALUE, label: "⟳ cheapest (auto)", description: "Always use the cheapest model with a configured key" },
  rlm: { value: SESSION_VALUE, label: "⌁ follow session model", description: "rlm_query / rlm_batch child engines use pi's active model" },
});

/** One overlay: a titled, filterable SelectList. Resolves value, or undefined on esc. */
async function pickFromList(
  ctx: ExtensionContext,
  title: string,
  items: readonly SelectItem[],
  initialIndex: number,
): Promise<string | undefined> {
  const chosen = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
    let query = "";
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const filterLine: Component = {
      render: (w) => [truncateToWidth(theme.fg("dim", `Filter: ${query || "type to filter…"}`), w)],
      invalidate: () => {},
    };
    const list = new SelectList([...items], Math.min(items.length, MAX_VISIBLE), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    if (initialIndex > 0) list.setSelectedIndex(initialIndex);
    const isFilterText = (s: string): boolean =>
      s.length > 0 && [...s].every((char) => char >= " " && char !== "\x7f");
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
  return chosen === null ? undefined : chosen;
}

function providerItems(role: PickerRole, catalog: readonly ProviderGroup[]): SelectItem[] {
  const items: SelectItem[] = [TOP_OPTIONS[role]];
  for (const g of catalog) items.push({ value: g.provider, label: g.provider, description: `${g.models.length} models` });
  return items;
}

function modelItems(group: ProviderGroup): SelectItem[] {
  const items: SelectItem[] = [{ value: BACK_VALUE, label: "← providers", description: "" }];
  for (const m of group.models) {
    items.push({ value: modelRefOf(m), label: m.id, description: m.reasoning ? "reasoning" : "" });
  }
  return items;
}

function levelItems(group: ProviderGroup, model: Model<Api>): SelectItem[] {
  const items: SelectItem[] = [{ value: BACK_VALUE, label: `← ${group.provider} models`, description: "" }];
  for (const level of supportedThinkingLevels(model)) {
    items.push({ value: level, label: level, description: `Use ${level} reasoning` });
  }
  return items;
}

/** Show the grouped picker; resolves ModelSelection, null = role's top option, undefined = cancel. */
export async function selectModel(
  ctx: ExtensionContext,
  role: PickerRole,
  models: readonly Model<Api>[],
  current?: Model<Api>,
  currentThinking?: ThinkingLevel,
  currentRef?: string,
): Promise<ModelSelection | null | undefined> {
  if (models.length === 0) {
    ctx.ui.notify("RLM: no models available (add a provider key in Pi, or widen --models / enabledModels)", "warning");
    return undefined;
  }
  if (ctx.mode !== "tui") {
    const fallback = models[0];
    if (fallback === undefined) return undefined;
    // Prefer an explicit pin (resolved model or saved ref) over "first = cheapest".
    const fromRef = currentRef ? models.find((m) => modelRefOf(m) === currentRef) : undefined;
    const model = current ?? fromRef ?? fallback;
    return { model, thinkingLevel: await selectThinkingLevel(ctx, model, currentThinking) };
  }

  const catalog = buildCatalog(models);
  const currentRefStr = current ? modelRefOf(current) : currentRef;
  const providerOf = (ref: string | undefined): string | undefined =>
    ref === undefined ? undefined : catalog.find((g) => g.models.some((m) => modelRefOf(m) === ref))?.provider;

  let group: ProviderGroup | undefined;
  let model: Model<Api> | undefined;
  // Drill-down with real back navigation: ← returns one level, esc cancels all.
  for (;;) {
    if (group === undefined) {
      const items = providerItems(role, catalog);
      const pre = providerOf(currentRefStr);
      const l1 = await pickFromList(ctx, role === "llm" ? "LLM model — provider" : "RLM model — provider", items,
        pre === undefined ? 0 : Math.max(0, items.findIndex((i) => i.value === pre)));
      if (l1 === undefined) return undefined;              // esc — cancel
      if (l1 === CHEAPEST_VALUE || l1 === SESSION_VALUE) return null; // role's top option
      group = catalog.find((g) => g.provider === l1);
      if (group === undefined) return undefined;
      continue;
    }
    if (model === undefined) {
      const mItems = modelItems(group);
      const l2 = await pickFromList(ctx, `${group.provider} › models`, mItems,
        Math.max(0, mItems.findIndex((i) => i.value === currentRefStr)));
      if (l2 === undefined) return undefined;
      if (l2 === BACK_VALUE) { group = undefined; continue; } // ← providers
      const picked = group.models.find((m) => modelRefOf(m) === l2);
      if (picked === undefined) return undefined;
      model = picked;
      if (supportedThinkingLevels(model).length === 0) return { model, thinkingLevel: undefined };
      continue;
    }
    const lvItems = levelItems(group, model);
    const l3 = await pickFromList(ctx, `${group.provider} › ${model.id}`, lvItems,
      Math.max(0, lvItems.findIndex((i) => i.value === currentThinking)));
    if (l3 === undefined) return undefined;
    if (l3 === BACK_VALUE) { model = undefined; continue; }  // ← models
    return { model, thinkingLevel: l3 === "off" ? undefined : (l3 as ThinkingLevel) };
  }
}
