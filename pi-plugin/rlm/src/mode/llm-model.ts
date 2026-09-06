/**
 * Sub-LLM model ranking — "cheapest available", with free models winning outright.
 *
 * Pi's `ModelCost` is non-nullable (`packages/ai/src/types.ts`), so a free model is a literal 0,
 * not a null. That makes plain price sorting ambiguous rather than wrong: subscription and
 * token-plan providers also publish 0, and a stable sort would hand back whichever 0-cost entry
 * happened to be first in catalog order. The tie-breaks below are what actually pick a usable
 * free model — and what make the pick identical across sessions and catalog reorderings.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** $/Mtok, input-weighted 3:1 — a sub-call sends a file body and gets back a sentence. */
function priceOf(model: Model<Api>): number {
  const { input, output, cacheRead } = model.cost;
  return input * 3 + output + cacheRead;
}

/** True when the model costs nothing to call on any axis. */
export function isFreeModel(model: Model<Api>): boolean {
  return priceOf(model) === 0;
}

/**
 * Negative when `a` is the better sub-LLM.
 *
 * Window before maxTokens before id: a free model with a 4K context is useless for bulk reading,
 * so price alone must not decide. The final id comparison exists only to make the result
 * deterministic — without it the pick drifts whenever a provider reorders its catalog.
 */
export function compareLlm(a: Model<Api>, b: Model<Api>): number {
  return (priceOf(a) - priceOf(b))
    || (b.contextWindow - a.contextWindow)
    || (b.maxTokens - a.maxTokens)
    || `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
}

/**
 * Best sub-LLM among the models whose provider has configured auth.
 *
 * Single pass rather than `[...models].sort()[0]`: the copy and the sort both allocate for a
 * result that is one element.
 */
export function cheapestModel(registry: ModelRegistry): Model<Api> | undefined {
  const models = registry.getAvailable();
  let best: Model<Api> | undefined;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (model === undefined) continue;
    // Sentinel negative cost (openrouter/auto reports −1e6) = unpriceable router. priceOf()
    // would crown it "cheapest" (−4M) — skip; fail closed on unknown prices.
    if ((model.cost?.input ?? 0) < 0 || (model.cost?.output ?? 0) < 0) continue;
    if (best === undefined || compareLlm(model, best) < 0) best = model;
  }
  return best;
}

/** Newer Pi hosts expose session-scoped models; 0.79 peers do not — duck-type safely.
 *  DRY: the ONE reflection probe — shared by /rlm-llm and /rlm-rlm. */
export function sessionScopedModels(
  ctx: ExtensionContext,
): readonly { readonly model: Model<Api> }[] | undefined {
  const scoped: unknown = Reflect.get(ctx, "scopedModels");
  return Array.isArray(scoped) ? scoped as readonly { readonly model: Model<Api> }[] : undefined;
}
