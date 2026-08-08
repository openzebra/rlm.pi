/** `/rlm-config` — choose worker model, reasoning level, and run settings (smart is always pi's active model). */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { cheapestModel } from "../mode/worker-model.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { selectModel } from "../ui/model-picker.ts";

export async function runRlmConfig(controller: RlmController, ctx: ExtensionContext): Promise<boolean> {
  const models = ctx.modelRegistry.getAvailable();

  const worker = await selectModel(ctx, "Worker model (sub-LLM / llm_query)", models, controller.workerModel, controller.config.subSampling.reasoning);
  if (worker !== undefined) {
    controller.workerModel = worker?.model;
    controller.setConfig(Object.freeze({
      ...controller.config,
      subSampling: Object.freeze({ ...controller.config.subSampling, reasoning: worker?.thinkingLevel }),
    }));
  }

  controller.setConfig(await showConfigPanel(ctx, controller.config));

  // Only an explicit choice touches the persisted pin. ESC (`undefined`) used to fall through
  // here and freeze whatever cheapest resolved to at that moment, which silently ended
  // "cheapest (auto)" for every later session — including once a cheaper model appeared.
  if (worker === null) controller.savedWorkerRef = undefined;          // "⟳ cheapest (auto)"
  else if (worker !== undefined) controller.savedWorkerRef = modelRef(worker.model);

  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());

  // Name the model that actually resolved, not "(cheapest)" — otherwise there is no way to
  // tell whether the free model in the catalog was the one picked.
  const pinned = controller.workerModel;
  const effective = pinned ?? cheapestModel(ctx.modelRegistry);
  const reasoning = controller.config.subSampling.reasoning;
  ctx.ui.notify(
    `RLM: worker=${modelRef(effective) ?? "(none available)"}`
    + `${pinned ? "" : " (cheapest, auto)"}${reasoning ? `/${reasoning}` : ""}`,
    "info",
  );
  return worker !== undefined;
}

export function registerRlmConfigCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-config", {
    description: "Configure RLM worker model and run settings.",
    handler: async (_args, ctx) => {
      await runRlmConfig(controller, ctx);
    },
  });
}
