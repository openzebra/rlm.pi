/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { loadSettings, mergeConfig } from "./config/settings.ts";
import { decideRlmInputRoute } from "./mode/input-router.ts";
import { RlmController } from "./mode/rlm-mode.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";

export default function rlmExtension(pi: ExtensionAPI): void {
  const persisted = loadSettings();
  const controller = new RlmController(mergeConfig(persisted.config));
  controller.savedSmartRef = persisted.smart;
  controller.savedWorkerRef = persisted.worker;

  pi.registerMessageRenderer(
    "rlm-answer",
    (message, _options, _theme) => new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );
  pi.registerMessageRenderer("rlm-question", (message, _options, _theme) =>
    new Markdown(`**RLM question**\n\n${String(message.content ?? "")}`, 1, 0, getMarkdownTheme()),
  );
  pi.registerMessageRenderer("rlm-intro", (message, _options, _theme) =>
    new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );

  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  // Register RLM as a Pi tool for inline tool card rendering (replaces setWidget)
  pi.registerTool(createRlmTool(controller));

  let guidePosted = false;
  pi.on("session_start", async (_event, ctx) => {
    setRlmModeStatus(ctx.ui, controller);
    if (!guidePosted && controller.enabled) {
      guidePosted = true;
      postRlmGuide(pi, controller);
    }
  });

  pi.on("context", async (event) => ({
    messages: event.messages.filter((message) => !(message.role === "custom" && message.customType === "rlm-intro")),
  }));

  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    const decision = decideRlmInputRoute({ source: event.source, text }, { enabled: controller.enabled, busy: controller.isBusy() });
    if (decision === "continue") return { action: "continue" };
    if (decision === "busy") {
      ctx.ui.notify("RLM is busy (use /rlm-stop to cancel).", "warning");
      return { action: "handled" };
    }

    // Route through the RLM tool: transform input so the agent calls the rlm tool.
    // The tool's renderCall/renderResult replace the old rlm-question/rlm-answer messages.
    return { action: "transform", text: `Use the rlm tool to handle this request: ${text}` };
  });

  pi.on("session_shutdown", async () => {
    controller.abort();
  });
}
