/**
 * pi-rlm — Recursive Language Model for the Pi coding agent.
 *
 * Native, server-less: the RLM engine drives pi's selected model as the root orchestrator over a
 * local python3 sandbox (the persistent REPL); sub-LLM calls are serviced in-process over the
 * sandbox's stdio pipe (no sockets, no HTTP). A live agent/subagent tree streams to the TUI.
 *
 * This entry stays thin: construct the controller, register the commands, render the final answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { loadSettings, mergeConfig } from "./config/settings.ts";
import { RlmController } from "./mode/rlm-mode.ts";

export default function rlmExtension(pi: ExtensionAPI): void {
  const persisted = loadSettings();
  const controller = new RlmController(mergeConfig(persisted.config));
  controller.savedSmartRef = persisted.smart;
  controller.savedWorkerRef = persisted.worker;

  // Render the RLM final answer as markdown in the chat.
  pi.registerMessageRenderer<{ iterations: number; costUsd: number }>(
    "rlm-answer",
    (message, _options, _theme) => new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );

  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  pi.on("session_shutdown", async () => {
    controller.abort();
  });
}
