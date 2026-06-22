/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { executeRlmRun, registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand, runRlmConfig } from "./commands/rlm-config.ts";
import { loadSettings, mergeConfig } from "./config/settings.ts";
import { decideRlmInputRoute } from "./mode/input-router.ts";
import { RlmController } from "./mode/rlm-mode.ts";
import { setRlmModeStatus } from "./ui/status.ts";

export default function rlmExtension(pi: ExtensionAPI): void {
  const persisted = loadSettings();
  const controller = new RlmController(mergeConfig(persisted.config));
  controller.savedSmartRef = persisted.smart;
  controller.savedWorkerRef = persisted.worker;

  pi.registerMessageRenderer<{ iterations: number; costUsd: number }>(
    "rlm-answer",
    (message, _options, _theme) => new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );
  pi.registerMessageRenderer("rlm-question", (message, _options, _theme) =>
    new Markdown(`**RLM question**\n\n${String(message.content ?? "")}`, 1, 0, getMarkdownTheme()),
  );

  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  pi.on("session_start", async (_event, ctx) => {
    setRlmModeStatus(ctx.ui, controller);
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    const decision = decideRlmInputRoute({ source: event.source, text }, { enabled: controller.enabled, busy: controller.isBusy() });
    if (decision === "continue") return { action: "continue" };
    if (decision === "busy") {
      ctx.ui.notify("RLM is busy (use /rlm-stop to cancel).", "warning");
      return { action: "handled" };
    }

    pi.sendMessage({ customType: "rlm-question", content: text, display: true });

    if (!controller.hasSavedModels()) {
      const configured = await runRlmConfig(pi, controller, ctx);
      if (!configured) {
        ctx.ui.notify("RLM: configure smart/worker models before routing prompts.", "warning");
        return { action: "handled" };
      }
    }

    void executeRlmRun(pi, controller, ctx, text, "", true);
    return { action: "handled" };
  });

  pi.on("session_shutdown", async () => {
    controller.abort();
  });
}
