/** Startup/help guide card for RLM mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { modelLabel } from "./status.ts";

export const RLM_GUIDE = `# RLM mode

{state}

## Commands

- \`/rlm\` — toggle RLM mode (shortcut: Ctrl+Shift+R). Turning it OFF also stops a running query.
- \`/rlm-llm\` — pin the LLM model for llm_query / llm_batch / map_files
- \`/rlm-rlm\` — pin the model for rlm_query / rlm_batch child engines (default: session model)
- \`/rlm-config\` — run limits and engine settings
- \`/rlm-stop\` — cancel the current run but stay in RLM mode (use /rlm or Ctrl+Shift+R to leave)

## Live tree

While agents run, a tree shows below the editor — Ctrl+R focuses it, Enter opens an agent's timeline.`;

export function postRlmGuide(pi: ExtensionAPI, controller: RlmController): void {
  const state = controller.enabled
    ? `● RLM ON — llm=${modelLabel(controller.llmModel, controller.savedLlmRef ?? "cheapest")} · rlm=${modelLabel(controller.rlmModel, controller.savedRlmRef ?? "session")}`
    : "○ RLM OFF";
  const content = RLM_GUIDE.replace("{state}", state);
  pi.sendMessage({ customType: "rlm-intro", content, display: true });
}
