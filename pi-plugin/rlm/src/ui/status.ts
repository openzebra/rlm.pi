/** Footer status line for RLM mode and active runs. */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RlmController } from "../mode/rlm-mode.ts";

const KEY = "rlm";

export function modelLabel(model: Model<Api> | undefined, fallback: string): string {
  return model ? `${model.provider}/${model.id}` : fallback;
}

export function formatRlmStateLine(controller: RlmController): string {
  if (!controller.enabled) return "○ RLM OFF";
  const smart = modelLabel(controller.smartModel, controller.savedSmartRef ?? "default");
  const smartSuffix = controller.config.smartReasoning ? `:${controller.config.smartReasoning}` : "";
  const worker = modelLabel(controller.workerModel, controller.savedWorkerRef ?? "cheapest");
  const workerSuffix = controller.config.subSampling.reasoning ? `:${controller.config.subSampling.reasoning}` : "";
  return `● RLM ON · smart=${smart}${smartSuffix} · worker=${worker}${workerSuffix}`;
}

export function setRlmModeStatus(ui: ExtensionUIContext, controller: RlmController): void {
  ui.setStatus(KEY, formatRlmStateLine(controller));
}

export function clearRlmStatus(ui: ExtensionUIContext): void {
  ui.setStatus(KEY, undefined);
}
