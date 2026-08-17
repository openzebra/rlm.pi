/**
 * grouping — pure model-catalog grouping for the drill-down picker.
 *
 * Level 1: providers (with model counts).
 * Level 2: models of one provider (label = full id, vendor prefix included —
 *          the id IS the user-facing name on openrouter et al).
 * Level 3: thinking levels ("variant") — owned by levels.ts, not here.
 *
 * No TUI imports; everything here is trivially unit-testable.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compareLlm } from "../../mode/llm-model.ts";

/** Sentinel SelectList value for "always use cheapest available" (llm role). */
export const CHEAPEST_VALUE = "__rlm_cheapest__";
/** Sentinel SelectList value for "follow pi's session model" (rlm role). */
export const SESSION_VALUE = "__rlm_session__";

export interface ProviderGroup {
  readonly provider: string;
  readonly models: readonly Model<Api>[];
}

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

/** Group models by provider, providers alphabetical, models cheapest-first inside. */
export function buildCatalog(models: readonly Model<Api>[]): readonly ProviderGroup[] {
  const groups = new Map<string, Model<Api>[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list === undefined) groups.set(m.provider, [m]);
    else list.push(m);
  }
  const out: ProviderGroup[] = [];
  for (const [provider, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ provider, models: [...list].sort(compareLlm) });
  }
  return out;
}

export const modelRefOf = (m: Model<Api>): string => `${m.provider}/${m.id}`;

/**
 * Index to pre-select in the flat model list (with cheapest row at 0 when included).
 * Without this, the list always opens on "cheapest (auto)" and Enter silently unpins.
 */
export function initialModelPickerIndex(
  models: readonly Model<Api>[],
  current?: Model<Api>,
  currentRef?: string,
  includeCheapest = true,
): number {
  const offset = includeCheapest ? 1 : 0;
  const ref = current ? modelRefOf(current) : currentRef;
  if (!ref) return 0;
  const idx = models.findIndex((m) => modelRefOf(m) === ref);
  // When a saved ref exists but the model is absent from the current catalog
  // (e.g. provider not refreshed yet), pre-select the first real model — NOT
  // "cheapest", which would silently unpin on save.
  return idx >= 0 ? idx + offset : Math.min(offset, models.length);
}
