/**
 * pins — apply model-picker selections to controller pin state.
 *
 * One function per role; both follow the same contract:
 *   `undefined` → ESC, no change · `null` → the role's top option (unpin) ·
 *   `ModelSelection` → pin model + its thinking level into the matching sampling slot.
 */

import { modelRef } from "../config/settings.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import type { ModelSelection } from "../ui/model-picker.ts";

export function applyLlmSelection(controller: RlmController, llm: ModelSelection | null | undefined): void {
  if (llm === undefined) return;
  if (llm === null) {
    controller.llmModel = undefined;
    controller.savedLlmRef = undefined;
    controller.explicitClearPin = true;
    return;
  }
  controller.llmModel = llm.model;
  controller.savedLlmRef = modelRef(llm.model);
  controller.explicitClearPin = false;
  controller.setConfig(Object.freeze({
    ...controller.config,
    subSampling: Object.freeze({
      ...controller.config.subSampling,
      reasoning: llm.thinkingLevel,
    }),
  }));
}

export function applyRlmSelection(controller: RlmController, rlm: ModelSelection | null | undefined): void {
  if (rlm === undefined) return;
  if (rlm === null) {
    controller.rlmModel = undefined;
    controller.savedRlmRef = undefined;
    controller.explicitClearRlmPin = true;
    return;
  }
  controller.rlmModel = rlm.model;
  controller.savedRlmRef = modelRef(rlm.model);
  controller.explicitClearRlmPin = false;
  controller.setConfig(Object.freeze({
    ...controller.config,
    rootSampling: Object.freeze({
      ...(controller.config.rootSampling ?? {}),
      reasoning: rlm.thinkingLevel,
    }),
  }));
}
