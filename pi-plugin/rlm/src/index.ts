/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { createReplTool } from "./tool/repl-tool.ts";
import { loadSettings, mergeConfig, resolveModelId } from "./config/settings.ts";
import { RlmController, cheapestModel } from "./mode/rlm-mode.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { packRepository, formatForLLM, serializeForSandbox } from "./context/repomix-context.ts";
import { buildNativeSystemPrompt } from "./prompts/system.ts";

export default function rlmExtension(pi: ExtensionAPI): void {
  const persisted = loadSettings();
  const config = mergeConfig(persisted.config);
  const controller = new RlmController(config);
  controller.savedSmartRef = persisted.smart;
  controller.savedWorkerRef = persisted.worker;

  // ── SandboxManager — persistent singleton for native-mode repl() ──
  const sandboxManager = new SandboxManager({
    execTimeoutS: config.execTimeoutS,
    requestTimeoutMs: config.requestTimeoutMs,
    python: config.python,
    sandboxInitTimeoutMs: config.sandboxInitTimeoutMs,
  });

  // ── Message renderers ──
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

  // ── Commands ──
  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  // ── Tool registration ──
  // Existing rlm tool (stays for backward compat with /rlm mode)
  pi.registerTool(createRlmTool(controller));

  // Native repl tool — worker model resolved on first session_start (needs ExtensionContext)
  let replToolRegistered = false;
  let guidePosted = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore saved model refs for controller
    if (persisted.smart) controller.smartModel = resolveModelId(ctx.modelRegistry, persisted.smart);
    if (persisted.worker) controller.workerModel = resolveModelId(ctx.modelRegistry, persisted.worker);

    // Register repl tool on first session (needs model from ExtensionContext)
    if (!replToolRegistered) {
      replToolRegistered = true;
      const workerModel = cheapestModel(ctx.modelRegistry) ?? ctx.model;
      const smartModel = controller.smartModel ?? ctx.model;
      if (workerModel && smartModel) {
        pi.registerTool(createReplTool({
          sandboxManager,
          smartModel,
          workerModel,
          registry: ctx.modelRegistry,
          config,
        }));
      }
    }

    setRlmModeStatus(ctx.ui, controller);
    if (!guidePosted && controller.enabled) {
      guidePosted = true;
      postRlmGuide(pi, controller);
    }
  });

  // ── System prompt: native RLM mode addendum (only when enabled) ──
  pi.on("before_agent_start", async (event) => {
    if (!controller.enabled) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + buildNativeSystemPrompt() };
  });

  // ── Context injection: repo listing for the main agent ──
  let contextInjected = false;
  pi.on("context", async (event, ctx) => {
    const filtered = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === "rlm-intro"),
    );

    // Inject repository context as a compact listing (once per session, only when RLM is enabled)
    if (controller.enabled && !contextInjected) {
      contextInjected = true;
      const cwd = ctx.cwd ?? process.cwd();
      const result = await packRepository(cwd);
      if (result.ok) {
        const contextText = formatForLLM(result.value);
        const contextMsg = {
          role: "user" as const,
          content: contextText,
          timestamp: 0,
        } as (typeof filtered)[number];

        // Store context for sandbox loading on first repl() call
        sandboxManager.contextPayload = serializeForSandbox(result.value);

        return { messages: [contextMsg, ...filtered] };
      }
    }

    return { messages: filtered };
  });

  // ── Input routing: native mode — agent decides whether to use repl() or other tools ──
  // The old black-box rlm() routing is removed; the main agent receives messages normally
  // and chooses natively when to call repl(), read, grep, zebra-mcp, etc.
  pi.on("input", async (_event, _ctx) => {
    return { action: "continue" };
  });

  // ── Session shutdown: cleanup ──
  pi.on("session_shutdown", async () => {
    controller.abort();
    await sandboxManager.dispose();
    contextInjected = false;
  });
}
