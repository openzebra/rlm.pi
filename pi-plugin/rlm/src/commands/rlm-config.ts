/** `/rlm-config` — choose the sub-LLM model, reasoning level, and run settings.
 *  The root model is always pi's active model; only the sub-LLM is configurable here. */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { cheapestModel } from "../mode/llm-model.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { pickableModels, selectModel, type ModelSelection } from "../ui/model-picker.ts";

/** Newer Pi hosts expose session-scoped models; 0.79 peers do not — duck-type safely. */
function sessionScopedModels(
  ctx: ExtensionContext,
): readonly { readonly model: Model<Api> }[] | undefined {
  const scoped: unknown = Reflect.get(ctx, "scopedModels");
  return Array.isArray(scoped) ? scoped as readonly { readonly model: Model<Api> }[] : undefined;
}

/**
 * Apply a model-picker result to controller pin state.
 *
 * - `null` → explicit "cheapest (auto)" (clear pin; leave reasoning alone)
 * - `ModelSelection` → pin that model (and its thinking level, which may be undefined)
 * - `undefined` → ESC / no change
 */
export function applyLlmSelection(
  controller: RlmController,
  llm: ModelSelection | null | undefined,
): void {
  if (llm === undefined) return;
  if (llm === null) {
    controller.llmModel = undefined;
    controller.savedLlmRef = undefined;
    controller.explicitClearPin = true;
    return;
  }
  controller.llmModel = llm.model;
  controller.savedLlmRef = modelRef(llm.model);
  controller.explicitClearPin = false;
  controller.setConfig(Object.freeze({
    ...controller.config,
    subSampling: Object.freeze({
      ...controller.config.subSampling,
      reasoning: llm.thinkingLevel,
    }),
  }));
}

export async function runRlmConfig(controller: RlmController, ctx: ExtensionContext): Promise<boolean> {
  // Match Pi's native list: refresh so a just-added key appears, then use scoped models when
  // the session narrowed them, else every available (auth-configured) model. Never getAll().
  try {
    await ctx.modelRegistry.refresh();
  } catch {
    // Fail-soft: show the cached available snapshot rather than aborting config.
  }
  const models = pickableModels(ctx.modelRegistry, sessionScopedModels(ctx));

  const llm = await selectModel(
    ctx,
    "LLM model (sub-calls: llm_query / map_files / rlm_query)",
    models,
    controller.llmModel,
    controller.config.subSampling.reasoning,
    controller.savedLlmRef,
  );
  // Only an explicit choice touches the pin. ESC leaves model + reasoning alone.
  // Choosing cheapest must NOT wipe subSampling.reasoning (null !== undefined used to).
  applyLlmSelection(controller, llm);

  // Persist model choice immediately — if showConfigPanel throws or process exits before it
  // returns, the pin survives (Root Cause #2, v0.3.2).
  if (llm !== undefined) {
    const saved = await controller.persist();
    if (!saved) ctx.ui.notify("RLM: failed to save llm setting", "error");
  }

  controller.setConfig(await showConfigPanel(ctx, controller.config));

  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());

  // Name the model that actually resolved, not "(cheapest)" — otherwise there is no way to
  // tell whether the free model in the catalog was the one picked.
  const pinned = controller.llmModel;
  const effective = pinned ?? cheapestModel(ctx.modelRegistry);
  const reasoning = controller.config.subSampling.reasoning;
  ctx.ui.notify(
    `RLM: llm=${modelRef(effective) ?? "(none available)"}`
    + `${pinned ? "" : " (cheapest, auto)"}${reasoning ? `/${reasoning}` : ""}`,
    "info",
  );
  return llm !== undefined;
}

export function registerRlmConfigCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-config", {
    description: "Configure the RLM sub-LLM model and run settings.",
    handler: async (_args, ctx) => {
      await runRlmConfig(controller, ctx);
    },
  });
}
