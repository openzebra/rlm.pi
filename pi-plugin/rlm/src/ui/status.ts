/** Status widget for RLM mode and active runs — rendered above the editor.
 *
 * The footer's extension-status row is sanitized to a single line, so the
 * two-model layout lives in a dedicated multi-line widget instead: one line
 * for the mode, one per model lane (llm = leaf sub-calls, rlm = child engines),
 * each with the live context token spend — and, when trace mode is on, a Root Σ
 * telemetry line (R6): Ξ compositions, digest compactions, elisions, Σ splices,
 * idle degrades.
 */

import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RlmController } from "../mode/rlm-mode.ts";
import { traceEnabled } from "../util/trace.ts";
import { formatTokens } from "./theme.ts";

const KEY = "rlm";

/** R6: Root Σ closure-counter snapshot (fresh readonly object per render). */
export interface RootSigmaTelemetry {
  readonly xiCompositions: number;
  readonly rootDigests: number;
  readonly elidedMessages: number;
  readonly sigmaSplices: number;
  readonly idleDegrades: number;
}

export function modelLabel(model: Model<Api> | undefined, fallback: string): string {
  return model ? `${model.provider}/${model.id}` : fallback;
}

/** R6: the Σ telemetry line — built only when tracing and at least one counter is live. */
function sigmaLine(telemetry: RootSigmaTelemetry): string | undefined {
  const parts: string[] = [];
  if (telemetry.xiCompositions > 0) parts.push(`Ξ${telemetry.xiCompositions}`);
  if (telemetry.elidedMessages > 0) parts.push(`elided ${telemetry.elidedMessages}`);
  if (telemetry.sigmaSplices > 0) parts.push(`Σ${telemetry.sigmaSplices}`);
  if (telemetry.rootDigests > 0) parts.push(`digest ${telemetry.rootDigests}`);
  if (telemetry.idleDegrades > 0) parts.push(`degraded ${telemetry.idleDegrades}`);
  return parts.length === 0 ? undefined : ` Σ ${parts.join(" · ")}`;
}

export function formatRlmStatusLines(
  controller: RlmController,
  contextUsage?: ContextUsage,
  telemetry?: RootSigmaTelemetry,
): readonly string[] {
  if (!controller.enabled) return ["○ RLM OFF"];
  const tokens = contextUsage?.tokens;
  const tokSuffix = tokens === null || tokens === undefined ? "" : ` · ${formatTokens(tokens)} tok`;
  const llm = modelLabel(controller.llmModel, controller.savedLlmRef ?? "cheapest");
  const llmSuffix = controller.config.subSampling.reasoning ? `:${controller.config.subSampling.reasoning}` : "";
  const rlm = modelLabel(controller.rlmModel, controller.savedRlmRef ?? "session");
  const rlmSuffix = controller.config.rootSampling?.reasoning ? `:${controller.config.rootSampling.reasoning}` : "";
  const lines = [
    "● RLM ON",
    ` llm=${llm}${llmSuffix}${tokSuffix}`,
    ` rlm=${rlm}${rlmSuffix}${tokSuffix}`,
  ];
  // R6: counters surface only under trace mode — the default UI stays clean.
  if (traceEnabled && telemetry !== undefined) {
    const sigma = sigmaLine(telemetry);
    if (sigma !== undefined) lines.push(sigma);
  }
  return lines;
}

/** Set the above-editor status widget. Idempotent — call on every state change. */
export function setRlmModeStatus(
  ctx: ExtensionContext,
  controller: RlmController,
  contextUsage?: ContextUsage,
  telemetry?: RootSigmaTelemetry,
): void {
  ctx.ui.setWidget(KEY, [...formatRlmStatusLines(controller, contextUsage, telemetry)], { placement: "aboveEditor" });
}
