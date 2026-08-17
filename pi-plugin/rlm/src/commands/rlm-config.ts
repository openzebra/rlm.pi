/** `/rlm-config` — run settings only. Model pins live in `/rlm-llm` and `/rlm-rlm`. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { setRlmModeStatus } from "../ui/status.ts";
import { showConfigPanel } from "../ui/config-panel.ts";

async function runRlmConfig(controller: RlmController, ctx: ExtensionContext): Promise<void> {
  controller.setConfig(await showConfigPanel(ctx, controller.config));
  const persisted = await controller.persist();
  if (!persisted) ctx.ui.notify("RLM: failed to save settings to ~/.pi/agent/rlm.json", "error");
  setRlmModeStatus(ctx, controller, ctx.getContextUsage());
}

export function registerRlmConfigCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm-config", {
    description: "Configure RLM run settings (models: /rlm-llm, /rlm-rlm).",
    handler: async (_args, ctx) => {
      await runRlmConfig(controller, ctx);
    },
  });
}
