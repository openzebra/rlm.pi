/** Startup/help guide card for RLM mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { modelLabel } from "./status.ts";
import { fillTpl, sigmaStrings } from "../ui/sigma-i18n.ts";

export function postRlmGuide(pi: ExtensionAPI, controller: RlmController): void {
  const s = sigmaStrings().intro;
  const state = controller.enabled
    ? fillTpl(s.on, {
        llm: modelLabel(controller.llmModel, controller.savedLlmRef ?? "cheapest"),
        rlm: modelLabel(controller.rlmModel, controller.savedRlmRef ?? "session"),
      })
    : s.off;
  const content = fillTpl(s.guide, { state });
  pi.sendMessage({ customType: "rlm-intro", content, display: true });
}
