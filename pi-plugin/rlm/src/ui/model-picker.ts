/**
 * Model picker TUI — choose the *smart* (root orchestrator) and *worker* (sub-LLM) models from
 * the models that have configured auth. Built on pi's `SelectList` (tui.md Pattern 1).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { formatCost } from "./theme.ts";

function items(models: Model<Api>[]): SelectItem[] {
  return models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.id}`,
    description: `in ${formatCost(m.cost.input)}/Mtok · out ${formatCost(m.cost.output)}/Mtok`,
  }));
}

/** Show a single-choice model selector; resolves to the chosen Model or undefined (cancelled). */
export async function selectModel(
  ctx: ExtensionContext,
  title: string,
  models: Model<Api>[],
  current?: Model<Api>,
): Promise<Model<Api> | undefined> {
  if (models.length === 0) {
    ctx.ui.notify("RLM: no models with configured auth", "warning");
    return undefined;
  }
  if (ctx.mode !== "tui") {
    // No interactive UI: keep the current/first model.
    return current ?? models[0];
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
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => list.handleInput(data),
    };
  });

  if (!chosen) return undefined;
  return models.find((m) => `${m.provider}/${m.id}` === chosen);
}
