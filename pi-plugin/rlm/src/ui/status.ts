/** Status widget for RLM mode and active runs — rendered above the editor.
 *
 * The footer's extension-status row is sanitized to a single line, so the
 * two-model layout lives in a dedicated multi-line widget instead: one line
 * for the mode, one per model lane (llm = leaf sub-calls, rlm = child engines),
 * each with the live context token spend.
 */

import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RlmController } from "../mode/rlm-mode.ts";
import { formatTokens } from "./theme.ts";

const KEY = "rlm";

export function modelLabel(model: Model<Api> | undefined, fallback: string): string {
  return model ? `${model.provider}/${model.id}` : fallback;
}

export function formatRlmStatusLines(
  controller: RlmController,
  contextUsage?: ContextUsage,
): readonly string[] {
  if (!controller.enabled) return ["○ RLM OFF"];
  const tokens = contextUsage?.tokens;
  const tokSuffix = tokens === null || tokens === undefined ? "" : ` · ${formatTokens(tokens)} tok`;
  const llm = modelLabel(controller.llmModel, controller.savedLlmRef ?? "cheapest");
  const llmSuffix = controller.config.subSampling.reasoning ? `:${controller.config.subSampling.reasoning}` : "";
  const rlm = modelLabel(controller.rlmModel, controller.savedRlmRef ?? "session");
  const rlmSuffix = controller.config.rootSampling?.reasoning ? `:${controller.config.rootSampling.reasoning}` : "";
  return [
    "● RLM ON",
    ` llm=${llm}${llmSuffix}${tokSuffix}`,
    ` rlm=${rlm}${rlmSuffix}${tokSuffix}`,
  ];
}

/** Set the above-editor status widget. Idempotent — call on every state change. */
export function setRlmModeStatus(ctx: ExtensionContext, controller: RlmController, contextUsage?: ContextUsage): void {
  ctx.ui.setWidget(KEY, [...formatRlmStatusLines(controller, contextUsage)], { placement: "aboveEditor" });
}
