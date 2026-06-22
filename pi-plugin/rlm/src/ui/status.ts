/** Footer status line for RLM mode and active runs. */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RlmController } from "../mode/rlm-mode.ts";

const KEY = "rlm";

function modelLabel(model: Model<Api> | undefined, fallback: string): string {
  return model ? `${model.provider}/${model.id}` : fallback;
}

export function setRlmModeStatus(ui: ExtensionUIContext, controller: RlmController): void {
  if (!controller.enabled) {
    ui.setStatus(KEY, "○ RLM OFF");
    return;
  }
  const smart = modelLabel(controller.smartModel, controller.savedSmartRef ?? "default");
  const worker = modelLabel(controller.workerModel, controller.savedWorkerRef ?? "cheapest");
  const smartReasoning = controller.config.smartReasoning ? ` · smartReasoning=${controller.config.smartReasoning}` : "";
  const workerReasoning = controller.config.subSampling.reasoning ? ` · workerReasoning=${controller.config.subSampling.reasoning}` : "";
  ui.setStatus(KEY, `● RLM ON · smart=${smart} · worker=${worker}${smartReasoning}${workerReasoning}`);
}

export function clearRlmStatus(ui: ExtensionUIContext): void {
  ui.setStatus(KEY, undefined);
}
