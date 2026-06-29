/** `/rlm-config` — choose worker model, reasoning level, and run settings (smart is always pi's active model). */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import { cheapestModel, type RlmController } from "../mode/rlm-mode.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { selectModel } from "../ui/model-picker.ts";

export async function runRlmConfig(controller: RlmController, ctx: ExtensionContext): Promise<boolean> {
  const models = ctx.modelRegistry.getAvailable();

  const worker = await selectModel(ctx, "Worker model (sub-LLM / llm_query)", models, controller.workerModel, controller.config.subSampling.reasoning);
  if (worker === null) {
    controller.workerModel = undefined;
    controller.config.subSampling.reasoning = undefined;
  } else if (worker) {
    controller.workerModel = worker.model;
    controller.config.subSampling.reasoning = worker.thinkingLevel;
  }

  await showConfigPanel(ctx, controller.config);

  if (worker === null) {
    controller.savedWorkerRef = undefined;
  } else {
    const effectiveWorker = controller.workerModel ?? cheapestModel(ctx.modelRegistry);
    controller.savedWorkerRef = modelRef(controller.workerModel) ?? modelRef(effectiveWorker);
  }
  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx.ui, controller);

  const w = controller.workerModel;
  ctx.ui.notify(
    `RLM: worker=${w ? `${w.provider}/${w.id}` : "(cheapest)"}${controller.config.subSampling.reasoning ? `/${controller.config.subSampling.reasoning}` : ""}`,
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
