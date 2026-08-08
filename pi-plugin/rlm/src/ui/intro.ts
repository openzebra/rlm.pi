/** Startup/help guide card for RLM mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { formatRlmStateLine } from "./status.ts";

export const RLM_GUIDE = `# RLM mode

{state}

## Commands

- \`/rlm\` — toggle RLM mode (shortcut: Ctrl+Shift+R). Turning it OFF also stops a running query.
- \`/rlm-config\` — choose models, reasoning, and budget limits
- \`/rlm-stop\` — cancel the current run but stay in RLM mode (use /rlm or Ctrl+Shift+R to leave)

When RLM mode is ON, \`read\`/\`grep\` are disabled and the agent reads the repository through the
\`repl\` tool, delegating bulk analysis to sub-LLMs. The footer/status line shows the current state.`;

export function postRlmGuide(pi: ExtensionAPI, controller: RlmController): void {
  const content = RLM_GUIDE.replace("{state}", formatRlmStateLine(controller));
  pi.sendMessage({ customType: "rlm-intro", content, display: true });
}
