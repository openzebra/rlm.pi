/**
 * levels — the "variant" level of the drill-down: a model's thinking levels.
 *
 * Extracted verbatim from the pre-grouping picker so the non-tui fallback and
 * the level list stay exactly as tested.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SelectableThinkingLevel = (typeof LEVELS)[number];

/** Levels the model actually supports, in canonical order. */
export function supportedThinkingLevels(model: Model<Api>): readonly SelectableThinkingLevel[] {
  const map = model.thinkingLevelMap;
  if (map === undefined) return [];
  const supported: SelectableThinkingLevel[] = [];
  for (const level of LEVELS) if (level in map) supported.push(level);
  return supported;
}

/** Ask the thinking level for a model (skipped entirely when unsupported). */
export async function selectThinkingLevel(
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
