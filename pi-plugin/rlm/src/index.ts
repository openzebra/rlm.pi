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
import { buildNativeSystemPrompt, NATIVE_TURN_REMINDER } from "./prompts/system.ts";
import { bashCommandFromInput, isFileReadingCommand, capToolResultText, BASH_BLOCK_REASON } from "./mode/native-guards.ts";
import { errorMessage } from "./util/errors.ts";

const BLOCKED_NATIVE_TOOLS = Object.freeze(new Set(["read", "grep"]));
const CAPPED_RESULT_TOOLS = Object.freeze(new Set(["bash", "find", "ls"]));

export default function rlmExtension(pi: ExtensionAPI): void {
  // Init synchronously with defaults — ensures commands/tools/handlers register before session_start
  const config = mergeConfig({});
  const controller = new RlmController(config);
  const sandboxManager = new SandboxManager({
    execTimeoutS: config.execTimeoutS,
    requestTimeoutMs: config.requestTimeoutMs,
    python: config.python,
    sandboxInitTimeoutMs: config.sandboxInitTimeoutMs,
    maxPromptChars: config.maxPromptChars,
  });
  let packedContextText: string | undefined;
  let contextPackPromise: Promise<string | undefined> | undefined;
  const ensureRepositoryContext = async (cwd: string): Promise<string | undefined> => {
    if (packedContextText !== undefined && sandboxManager.contextPayload !== null) return packedContextText;
    contextPackPromise ??= packRepository(cwd)
      .then((result) => {
        if (!result.ok) {
          console.warn(`[rlm] repository context pack failed: ${result.error}`);
          return undefined;
        }
        sandboxManager.contextPayload = serializeForSandbox(result.value);
        packedContextText = formatForLLM(result.value);
        return packedContextText;
      })
      .finally(() => { contextPackPromise = undefined; });
    return contextPackPromise;
  };

  // Load persisted settings async — applied before session_start handler reads controller state
  const settingsReady = loadSettings()
    .then((persisted) => {
      controller.config = mergeConfig(persisted.config);
      controller.savedWorkerRef = persisted.worker;
    })
    .catch((err) => {
      console.warn(`[rlm] settings load failed: ${errorMessage(err)}`);
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
  pi.registerTool(createRlmTool(controller));
  let guidePosted = false;

  pi.on("session_start", async (_event, ctx) => {
    // Wait for persisted settings before reading controller state
    await settingsReady;

    if (controller.savedWorkerRef) {
      const resolved = resolveModelId(ctx.modelRegistry, controller.savedWorkerRef);
      if (resolved) controller.workerModel = resolved;
    }

    // Re-register repl tool each session to pick up model provider changes
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
          config: controller.config,
          ensureContext: async () => {
            const contextText = await ensureRepositoryContext(ctx.cwd ?? process.cwd());
            if (contextText === undefined) throw new Error("repository context could not be loaded into RLM sandbox");
          },
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
      (message) =>
        !(message.role === "custom" && message.customType === "rlm-intro")
        && !(message.role === "user" && typeof message.content === "string" && message.content === NATIVE_TURN_REMINDER),
    );
    if (!controller.enabled) return { messages: filtered };

    type PiMessage = (typeof filtered)[number];

    // Inject repository context as a compact listing (once per session)
    if (!contextInjected) {
      const cwd = ctx.cwd ?? process.cwd();
      const contextText = await ensureRepositoryContext(cwd);
      if (contextText !== undefined) {
        contextInjected = true;
        const instruction = [
          "ANALYZE THIS REPOSITORY using repl({code}) — read/grep are DISABLED.",
          "Repository contents are pre-loaded in the Python REPL `context` variable.",
          "Chunk context via Python, delegate to llm_query. If credits exhausted → report and stop.",
          "",
        ].join("\n");
        filtered.unshift({
          role: "user" as const,
          content: instruction + contextText,
          timestamp: 0,
        } as PiMessage);
      }
    }

    // Per-turn last-position reminder (not persisted — context hook rebuilds every request)
    filtered.push({
      role: "user" as const,
      content: NATIVE_TURN_REMINDER,
      timestamp: 0,
    } as PiMessage);

    return { messages: filtered };
  });

  // ── Input routing: native mode — agent decides whether to use repl() or other tools ──
  pi.on("input", async (_event, _ctx) => {
    return { action: "continue" };
  });

  // ── Native mode restrictions: keep bulk file content out of root-model context ──
  // `edit`/`write` stay unblocked so the agent modifies files through Pi's native
  // tool flow (visible to all plugins, +/- diff preview). File reading/searching
  // belongs in the REPL, and bash output is capped as a backstop.
  pi.on("tool_call", async (event) => {
    if (!controller.enabled) return;
    if (BLOCKED_NATIVE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "RLM mode active. Use repl({code}) to read files and search the repository — all files are pre-loaded in the REPL `context` variable. Use `edit`/`write` for file changes. If sub-LLM credits are exhausted, report to the user.",
      };
    }
    const bashCommand = event.toolName === "bash" ? bashCommandFromInput(event.input) : undefined;
    if (bashCommand !== undefined && isFileReadingCommand(bashCommand)) {
      return { block: true, reason: BASH_BLOCK_REASON };
    }
  });

  pi.on("tool_result", async (event) => {
    if (!controller.enabled || !CAPPED_RESULT_TOOLS.has(event.toolName)) return;
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const capped = capToolResultText(c.text);
      if (capped === undefined) return c;
      changed = true;
      return { ...c, type: "text" as const, text: capped };
    });
    return changed ? { content } : undefined;
  });

  // ── Session shutdown: cleanup ──
  pi.on("session_shutdown", async () => {
    controller.abort();
    await sandboxManager.dispose();
    contextInjected = false;
    packedContextText = undefined;
    contextPackPromise = undefined;
    sandboxManager.contextPayload = null;
  });
}
