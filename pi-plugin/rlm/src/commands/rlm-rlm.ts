/** `/rlm-rlm` — pin the root/worker model for rlm_query / rlm_batch child engines.
 *
 * Unpinned (default), child engines follow pi's active session model — exactly
 * the pre-pin behavior, now an explicit picker row.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { pickableModels, selectModel } from "../ui/model-picker.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { applyRlmSelection } from "./pins.ts";

function sessionScopedModels(
  ctx: ExtensionContext,
): readonly { readonly model: Model<Api> }[] | undefined {
  const scoped: unknown = Reflect.get(ctx, "scopedModels");
  return Array.isArray(scoped) ? scoped as readonly { readonly model: Model<Api> }[] : undefined;
}

async function runRlmRlm(controller: RlmController, ctx: ExtensionContext): Promise<void> {
  try {
    await ctx.modelRegistry.refresh();
  } catch {
    // Fail-soft: show the cached available snapshot rather than aborting config.
  }
  const models = pickableModels(ctx.modelRegistry, sessionScopedModels(ctx));
  const rlm = await selectModel(
    ctx,
    "rlm",
    models,
    controller.rlmModel,
    controller.config.rootSampling?.reasoning,
    controller.savedRlmRef,
  );
  applyRlmSelection(controller, rlm);
  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx, controller, ctx.getContextUsage());

  const reasoning = controller.config.rootSampling?.reasoning;
  ctx.ui.notify(
    controller.rlmModel
      ? `RLM: rlm=${modelRef(controller.rlmModel) ?? "(none)"}${reasoning ? `/${reasoning}` : ""}`
      : "RLM: rlm follows session model",
    "info",
  );
}

export function registerRlmRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-rlm", {
    description: "Pin the model used by rlm_query / rlm_batch child engines (default: session model).",
    handler: async (_args, ctx) => {
      await runRlmRlm(controller, ctx);
    },
  });
}
