/** Startup/help guide card for RLM mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { formatRlmStateLine } from "./status.ts";

export const RLM_GUIDE = `# RLM mode

{state}

## Commands

- \`/rlm\` — toggle RLM mode (shortcut: Ctrl+Shift+R)
- \`/rlm <q>\` — ask a one-shot RLM question
- \`/rlm --file <path> <q>\` — include large file context
- \`/rlm --paste <q>\` — paste context for a question
- \`/rlm-config\` — choose models, reasoning, and budget limits
- \`/rlm-stop\` — stop the active RLM run
- \`/rlm-help\` — show this guide again

When RLM mode is ON, plain messages route to RLM. The footer/status line shows the current state.`;

export function postRlmGuide(pi: ExtensionAPI, controller: RlmController): void {
  const content = RLM_GUIDE.replace("{state}", formatRlmStateLine(controller));
  pi.sendMessage({ customType: "rlm-intro", content, display: true });
}
