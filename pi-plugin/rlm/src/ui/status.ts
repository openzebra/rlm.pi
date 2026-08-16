/** Footer status line for RLM mode and active runs. */

import type { ContextUsage, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RlmController } from "../mode/rlm-mode.ts";

const KEY = "rlm";

export function modelLabel(model: Model<Api> | undefined, fallback: string): string {
  return model ? `${model.provider}/${model.id}` : fallback;
}

export function formatRlmStateLine(controller: RlmController, contextUsage?: ContextUsage): string {
  if (!controller.enabled) return "○ RLM OFF";
  const llm = modelLabel(controller.llmModel, controller.savedLlmRef ?? "cheapest");
  const llmSuffix = controller.config.subSampling.reasoning ? `:${controller.config.subSampling.reasoning}` : "";
  // `percent` is null right after a compaction, before the next assistant response reports usage.
  const percent = contextUsage?.percent;
  const ctxSuffix = percent === null || percent === undefined ? "" : ` · ctx ${Math.round(percent)}%`;
  // v5 provider caps (set via rlm.json): keep the effective admission visible.
  const caps = controller.config.providerMaxConcurrent;
  const capsSuffix = caps === undefined ? "" : ` · caps ${Object.entries(caps).map(([p, n]) => `${p}=${n}`).join(",")}`;
  return `● RLM ON · llm=${llm}${llmSuffix}${ctxSuffix}${capsSuffix}`;
}

export function setRlmModeStatus(ui: ExtensionUIContext, controller: RlmController, contextUsage?: ContextUsage): void {
  ui.setStatus(KEY, formatRlmStateLine(controller, contextUsage));
}
