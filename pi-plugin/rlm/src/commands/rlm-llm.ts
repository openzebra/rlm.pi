/** `/rlm-llm` — pin the leaf-LLM model (llm_query / llm_batch / map_files). */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import { cheapestModel } from "../mode/llm-model.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { pickableModels, selectModel } from "../ui/model-picker.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { applyLlmSelection } from "./pins.ts";

/** Newer Pi hosts expose session-scoped models; 0.79 peers do not — duck-type safely. */
function sessionScopedModels(
  ctx: ExtensionContext,
): readonly { readonly model: Model<Api> }[] | undefined {
  const scoped: unknown = Reflect.get(ctx, "scopedModels");
  return Array.isArray(scoped) ? scoped as readonly { readonly model: Model<Api> }[] : undefined;
}

async function runRlmLlm(controller: RlmController, ctx: ExtensionContext): Promise<void> {
  try {
    await ctx.modelRegistry.refresh();
  } catch {
    // Fail-soft: show the cached available snapshot rather than aborting config.
  }
  const models = pickableModels(ctx.modelRegistry, sessionScopedModels(ctx));
  const llm = await selectModel(
    ctx,
    "llm",
    models,
    controller.llmModel,
    controller.config.subSampling.reasoning,
    controller.savedLlmRef,
  );
  applyLlmSelection(controller, llm);
  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx, controller, ctx.getContextUsage());

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
}

export function registerRlmLlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-llm", {
    description: "Pin the LLM model used by llm_query / llm_batch / map_files sub-calls.",
    handler: async (_args, ctx) => {
      await runRlmLlm(controller, ctx);
    },
  });
}
