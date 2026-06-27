/** `/rlm-config` — choose smart/worker models, reasoning levels, and run settings. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef } from "../config/settings.ts";
import { cheapestModel, type RlmController } from "../mode/rlm-mode.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { selectModel } from "../ui/model-picker.ts";

export async function runRlmConfig(pi: ExtensionAPI, controller: RlmController, ctx: ExtensionContext): Promise<boolean> {
  const models = ctx.modelRegistry.getAvailable();

  let selectedAny = false;
  const smart = await selectModel(ctx, "Smart model (root orchestrator)", models, controller.smartModel ?? ctx.model, controller.config.smartReasoning);
  if (smart) {
    selectedAny = true;
    controller.smartModel = smart.model;
    controller.config.smartReasoning = smart.thinkingLevel;
    await pi.setModel(smart.model); // the orchestrator runs on pi's active model
  }

  const worker = await selectModel(ctx, "Worker model (sub-LLM / llm_query)", models, controller.workerModel, controller.config.subSampling.reasoning);
  if (worker) {
    selectedAny = true;
    controller.workerModel = worker.model;
    controller.config.subSampling.reasoning = worker.thinkingLevel;
  }

  await showConfigPanel(ctx, controller.config);

  const effectiveSmart = controller.smartModel ?? ctx.model;
  const effectiveWorker = controller.workerModel ?? cheapestModel(ctx.modelRegistry);
  controller.savedSmartRef = modelRef(controller.smartModel) ?? modelRef(effectiveSmart);
  controller.savedWorkerRef = modelRef(controller.workerModel) ?? modelRef(effectiveWorker);
  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx.ui, controller);

  const s = controller.smartModel ?? ctx.model;
  const w = controller.workerModel;
  ctx.ui.notify(
    `RLM: smart=${s ? `${s.provider}/${s.id}` : "(pi default)"}${controller.config.smartReasoning ? `/${controller.config.smartReasoning}` : ""}  worker=${w ? `${w.provider}/${w.id}` : "(cheapest)"}${controller.config.subSampling.reasoning ? `/${controller.config.subSampling.reasoning}` : ""}`,
    "info",
  );
  return selectedAny;
}

export function registerRlmConfigCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-config", {
    description: "Configure RLM smart/worker models and run settings.",
    handler: async (_args, ctx) => {
      await runRlmConfig(pi, controller, ctx);
    },
  });
}
