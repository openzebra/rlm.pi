/**
 * `/rlm-config` — choose the smart (root) and worker (sub-LLM) models, then tweak run settings.
 * Smart model selection also updates pi's active model so the orchestrator uses it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelRef, saveSettings } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import { showConfigPanel } from "../ui/config-panel.ts";
import { selectModel } from "../ui/model-picker.ts";

export function registerRlmConfigCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-config", {
    description: "Configure RLM smart/worker models and run settings.",
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry.getAvailable();

      const smart = await selectModel(ctx, "Smart model (root orchestrator)", models, controller.smartModel ?? ctx.model);
      if (smart) {
        controller.smartModel = smart;
        await pi.setModel(smart); // the orchestrator runs on pi's active model
      }

      const worker = await selectModel(ctx, "Worker model (sub-LLM / llm_query)", models, controller.workerModel);
      if (worker) controller.workerModel = worker;

      await showConfigPanel(ctx, controller.config);

      saveSettings({
        config: controller.config,
        smart: modelRef(controller.smartModel),
        worker: modelRef(controller.workerModel),
      });

      const s = controller.smartModel ?? ctx.model;
      const w = controller.workerModel;
      ctx.ui.notify(
        `RLM: smart=${s ? `${s.provider}/${s.id}` : "(pi default)"}  worker=${w ? `${w.provider}/${w.id}` : "(cheapest)"}`,
        "info",
      );
    },
  });
}
