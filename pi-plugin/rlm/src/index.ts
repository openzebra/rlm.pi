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

  // Native repl tool — re-registered each session to pick up model provider changes
  let guidePosted = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore saved model refs for controller — invalidate if provider changed
    if (persisted.smart) {
      const resolved = resolveModelId(ctx.modelRegistry, persisted.smart);
      if (resolved) controller.smartModel = resolved;
      else persisted.smart = undefined; // provider gone, clear stale ref
    }
    if (persisted.worker) {
      const resolved = resolveModelId(ctx.modelRegistry, persisted.worker);
      if (resolved) controller.workerModel = resolved;
      else persisted.worker = undefined;
    }

    // Register repl tool with current models (re-registers each session for provider changes)
    const workerModel = controller.workerModel ?? cheapestModel(ctx.modelRegistry) ?? ctx.model;
    const smartModel = controller.smartModel ?? ctx.model;
    if (workerModel && smartModel) {
      try {
        pi.registerTool(createReplTool({ sandboxManager, smartModel, workerModel, registry: ctx.modelRegistry, config }));
      } catch { /* re-registration on provider change — ignore if already registered */ }
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
        const instruction = [
          "ANALYZE THIS REPOSITORY using repl({code}) — read/grep/bash are DISABLED.",
          `Total: ${result.value.totalFiles} files, ${result.value.totalChars.toLocaleString()} chars — must use repl().`,
          "Chunk context via Python, delegate to llm_query. If credits exhausted → report and stop.",
          "",
        ].join("\n");
        const contextMsg = {
          role: "user" as const,
          content: instruction + contextText,
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

  // ── Tool restriction: block read/grep/bash when RLM is ON ──
  pi.on("tool_call", async (event) => {
    if (!controller.enabled) return;
    const blocked = new Set(["read", "grep", "bash"]);
    if (blocked.has(event.toolName)) {
      return {
        block: true,
        reason: "RLM mode active. Use repl({code}) to access the repository context. All files are pre-loaded in the REPL. If sub-LLM credits are exhausted, report to the user.",
      };
    }
  });

  // ── Session shutdown: cleanup ──
  pi.on("session_shutdown", async () => {
    controller.abort();
    await sandboxManager.dispose();
    contextInjected = false;
  });
}
