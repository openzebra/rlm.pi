/** `/rlm-config` — choose the sub-LLM model, reasoning level, and run settings.
 *  The root model is always pi's active model; only the sub-LLM is configurable here. */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { cheapestModel } from "../mode/llm-model.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { pickableModels, selectModel } from "../ui/model-picker.ts";

/** Newer Pi hosts expose session-scoped models; 0.79 peers do not — duck-type safely. */
function sessionScopedModels(
  ctx: ExtensionContext,
): readonly { readonly model: Model<Api> }[] | undefined {
  const scoped: unknown = Reflect.get(ctx, "scopedModels");
  return Array.isArray(scoped) ? scoped as readonly { readonly model: Model<Api> }[] : undefined;
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
  );
  if (llm !== undefined) {
    controller.llmModel = llm?.model;
    controller.setConfig(Object.freeze({
      ...controller.config,
      subSampling: Object.freeze({ ...controller.config.subSampling, reasoning: llm?.thinkingLevel }),
    }));
  }

  controller.setConfig(await showConfigPanel(ctx, controller.config));

  // Only an explicit choice touches the persisted pin. ESC (`undefined`) used to fall through
  // here and freeze whatever cheapest resolved to at that moment, which silently ended
  // "cheapest (auto)" for every later session — including once a cheaper model appeared.
  if (llm === null) controller.savedLlmRef = undefined;          // "⟳ cheapest (auto)"
  else if (llm !== undefined) controller.savedLlmRef = modelRef(llm.model);

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
