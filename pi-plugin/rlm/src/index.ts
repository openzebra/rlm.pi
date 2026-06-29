/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { createApplyDiffTool } from "./tool/apply-diff-tool.ts";
import { createReplTool } from "./tool/repl-tool.ts";
import { loadSettings, mergeConfig, resolveModelId } from "./config/settings.ts";
import { RlmController, cheapestModel } from "./mode/rlm-mode.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { packRepository, formatForLLM, serializeForSandbox } from "./context/repomix-context.ts";
import { buildNativeSystemPrompt } from "./prompts/system.ts";
import { errorMessage } from "./util/errors.ts";

const BLOCKED_NATIVE_TOOLS = Object.freeze(new Set(["read", "grep", "bash", "write", "edit"]));

export default function rlmExtension(pi: ExtensionAPI): void {
  void setupRlmExtension(pi).catch((error) => {
    console.warn(`[rlm] extension setup failed: ${errorMessage(error)}`);
  });
}

async function setupRlmExtension(pi: ExtensionAPI): Promise<void> {
  const persisted = await loadSettings();
  const config = mergeConfig(persisted.config);
  const controller = new RlmController(config);
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
  pi.registerTool(createApplyDiffTool());

  // Native repl tool — re-registered each session to pick up model provider changes
  let guidePosted = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore saved worker ref — retry lazily if registry/auth is not ready yet.
    // session_start can fire before the provider/auth registry is fully loaded, so a miss
    // here does NOT mean the ref is stale: RlmController.resolveModels() retries later.
    if (controller.savedWorkerRef) {
      const resolved = resolveModelId(ctx.modelRegistry, controller.savedWorkerRef);
      if (resolved) controller.workerModel = resolved;
    }

    // Register repl tool with current models (re-registers each session for provider changes)
    const workerModel = controller.workerModel ?? cheapestModel(ctx.modelRegistry) ?? ctx.model;
    const model = ctx.model;
    if (workerModel && model) {
      try {
        pi.registerTool(createReplTool({
          sandboxManager,
          model,
          workerModel,
          getModel: () => controller.resolveModels(ctx)?.model,
          getWorkerModel: () => controller.resolveModels(ctx)?.worker,
          registry: ctx.modelRegistry,
          config,
        }));
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
    if (BLOCKED_NATIVE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "RLM mode active. Use repl({code}) to read files and apply_diff({diff}) to modify them. All files are pre-loaded in the REPL. If sub-LLM credits are exhausted, report to the user.",
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
