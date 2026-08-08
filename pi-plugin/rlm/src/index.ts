/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { createReplTool } from "./tool/repl-tool.ts";
import { loadSettings, mergeConfig, resolveModelId } from "./config/settings.ts";
import { RlmController } from "./mode/rlm-mode.ts";
import { cheapestModel } from "./mode/worker-model.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";
import { markdownTheme } from "./ui/theme-adapter.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { createSubcallGates } from "./util/concurrency.ts";
import { BackgroundTasks } from "./tool/background-tasks.ts";
import { packRepository, formatForLLM, serializeForSandbox } from "./context/repomix-context.ts";
import { buildNativeSystemPrompt, NATIVE_TURN_REMINDER } from "./prompts/native.ts";
import { bashCommandFromInput, isFileReadingCommand, capToolResultText, BASH_BLOCK_REASON } from "./mode/native-guards.ts";
import { errorMessage } from "./util/errors.ts";

const BLOCKED_NATIVE_TOOLS = Object.freeze(new Set(["read", "grep"]));
/** How often to keep the parent sandbox's request watchdog alive during detached work. */
const WATCHDOG_HEARTBEAT_MS = 30_000;
const CAPPED_RESULT_TOOLS = Object.freeze(new Set(["bash", "find", "ls"]));

export default function rlmExtension(pi: ExtensionAPI): void {
  // Init synchronously with defaults — ensures commands/tools/handlers register before session_start
  const config = mergeConfig({});
  const controller = new RlmController(config);
  let onSandboxDiscardExtra: (() => void) | undefined;
  const sandboxManager = new SandboxManager({
    execTimeoutS: config.execTimeoutS,
    requestTimeoutMs: config.requestTimeoutMs,
    python: config.python,
    sandboxInitTimeoutMs: config.sandboxInitTimeoutMs,
    maxPromptChars: config.maxPromptChars,
    // Same wall budget as the parent request watchdog — a stalled sub-call should surface
    // inside the cell rather than hang the session forever.
    awaitTimeoutS: Math.round(config.requestTimeoutMs / 1000),
    onSandboxDiscarded: () => { onSandboxDiscardExtra?.(); },
  });
  // One admission gate for the whole session: spawn() lets the sandbox put many requests on
  // the wire at once, so nothing smaller than session scope actually bounds fan-out.
  const gates = createSubcallGates(config.maxConcurrentSubcalls, config.maxConcurrentChildren);
  const background = new BackgroundTasks({
    maxBudgetUsd: config.maxBudgetUsd,
    maxTimeoutMs: config.maxTimeoutMs,
    maxTokens: config.maxTokens,
    maxErrors: config.maxErrors,
  });
  // A detached child works in its OWN sandbox, so this one sees no frames and its request
  // watchdog would fire mid-await and SIGKILL a healthy worker, taking the REPL namespace
  // with it. Keep it alive while detached work is genuinely in flight.
  const watchdogHeartbeat = setInterval(() => {
    if (background.pending > 0) sandboxManager.refreshWatchdog();
  }, WATCHDOG_HEARTBEAT_MS);
  watchdogHeartbeat.unref();

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
  // Markdown themes are derived from the injected `theme`, never pi's module-global
  // `getMarkdownTheme()` — under jiti that global can be undefined inside a plugin.
  pi.registerMessageRenderer("rlm-answer", (message, _options, theme) =>
    new Markdown(String(message.content ?? ""), 1, 0, markdownTheme(theme)),
  );
  pi.registerMessageRenderer("rlm-question", (message, _options, theme) =>
    new Markdown(`**RLM question**\n\n${String(message.content ?? "")}`, 1, 0, markdownTheme(theme)),
  );
  pi.registerMessageRenderer("rlm-intro", (message, _options, theme) =>
    new Markdown(String(message.content ?? ""), 1, 0, markdownTheme(theme)),
  );

  // ── CLI flag: `pi --rlm` / `pi --rlm=false` overrides the persisted mode for this run ──
  pi.registerFlag("rlm", {
    description: "Start with RLM mode on (repl-only repository reading).",
    type: "boolean",
  });

  // ── Commands ──
  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  // ── Tool registration ──
  pi.registerTool(createRlmTool(controller));
  let guidePosted = false;

  pi.on("session_start", async (_event, ctx) => {
    // Wait for persisted settings before reading controller state
    await settingsReady;

    // An explicit --rlm flag wins over the persisted setting for this session.
    const flag = pi.getFlag("rlm");
    if (typeof flag === "boolean") controller.setConfig(Object.freeze({ ...controller.config, enabled: flag }));

    // Reload the catalog before the worker-model pick below reads it. Newer pi builds make
    // `getAvailable()` an async-populated snapshot that starts empty, and picking from an empty
    // catalog silently falls back to the root model. Called with no arguments and awaited so it
    // is valid whether `refresh` returns void (current) or a promise (newer); fail-soft, because
    // a refresh error must not abort session start.
    try {
      await ctx.modelRegistry.refresh();
    } catch (err) {
      console.warn(`[rlm] model registry refresh failed: ${errorMessage(err)}`);
    }

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
          getConfig: () => controller.config,
          gates,
          background,
          registerDiscardHook: (reset) => { onSandboxDiscardExtra = reset; },
          ensureContext: async () => {
            const contextText = await ensureRepositoryContext(ctx.cwd ?? process.cwd());
            if (contextText === undefined) throw new Error("repository context could not be loaded into RLM sandbox");
          },
        }));
      } catch (err) {
        // Re-registering the same tool each session is expected; anything else is a real failure.
        const message = errorMessage(err);
        if (!/already (registered|exists)/i.test(message)) {
          console.warn(`[rlm] repl tool registration failed: ${message}`);
        }
      }
    }

    setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());
    if (!guidePosted && controller.enabled) {
      guidePosted = true;
      postRlmGuide(pi, controller);
    }
  });

  // ── Keep the footer's context reading live (RLM exists to shrink this number) ──
  pi.on("turn_end", async (_event, ctx) => {
    setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());
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
          "Locate with search()/grep_context()/outline() (free), then delegate bulk reading to",
          "map_files()/llm_query_batched(). If credits exhausted → report and stop.",
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
    clearInterval(watchdogHeartbeat);
    background.dispose();
    await sandboxManager.dispose();
    contextInjected = false;
    packedContextText = undefined;
    contextPackPromise = undefined;
    sandboxManager.contextPayload = null;
  });
}
