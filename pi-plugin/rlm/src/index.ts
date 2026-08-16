/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import type { RlmConfig } from "./core/types.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { createReplTool } from "./tool/repl-tool.ts";
import { loadSettings, mergeConfig, resolveModelId } from "./config/settings.ts";
import { RlmController } from "./mode/rlm-mode.ts";
import { cheapestModel } from "./mode/llm-model.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";
import { markdownTheme } from "./ui/theme-adapter.ts";
import { SANDBOX_WATCHDOG_HEARTBEAT_MS } from "./sandbox/sandbox.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { buildSessionGates, type SubcallGates } from "./util/concurrency.ts";
import { BackgroundTasks } from "./tool/background-tasks.ts";
import { MemoryStore } from "./core/memory.ts";
import { modelComplete } from "./bridge/model.ts";
import { resolve } from "node:path";
import { resolveSource } from "./context/resolve.ts";
import { formatContextListing } from "./context/listing.ts";
import { extractEditPaths, readDiskFile } from "./context/refresh.ts";
import type { AddContextHandlerBundle } from "./bridge/add-context.ts";
import { buildNativeSystemPrompt } from "./prompts/native.ts";
import { capToolResultText } from "./mode/native-guards.ts";
import {
  isSubagentChildBypass,
  commitSubagentForceActivation,
  shouldEnforceNativeReaderBlock,
  processRlmDepth,
} from "./mode/subagent.ts";
import { errorMessage } from "./util/errors.ts";
import { trace, traceEnabled } from "./util/trace.ts";

export {
  isSubagentChildBypass,
  commitSubagentForceActivation,
  shouldEnforceNativeReaderBlock,
  processRlmDepth,
} from "./mode/subagent.ts";

/** Soft token guard — cap bulk tool stdout; do NOT hard-block read/grep/bash readers. */
const CAPPED_RESULT_TOOLS = Object.freeze(new Set(["bash", "find", "ls", "read", "grep"]));

export default function rlmExtension(pi: ExtensionAPI): void {
  // Subagent children may bypass full RLM registration. Env fast path when
  // PI_SUBAGENT_CHILD=1 (unless force-in under the depth cap). See mode/subagent.ts.
  if (isSubagentChildBypass()) {
    if (traceEnabled) {
      trace("subagent.bypass", {
        reason: process.env.PI_RLM_FORCE_IN_SUBAGENT === "1" ? "force_depth_cap" : "child",
        depth: processRlmDepth(),
      });
    }
    return;
  }
  commitSubagentForceActivation();
  if (traceEnabled && process.env.PI_SUBAGENT_CHILD === "1") {
    trace("subagent.force", { depth: processRlmDepth() });
  }

  // Init synchronously with defaults — ensures commands/tools/handlers register before session_start
  const config = mergeConfig({});
  // v5 durable memory: one store per session under <cwd>/.rlm/memory (L1 replay + L2 notes).
  // NOTE (audit M4): this store IS shared by both composition roots, but the TaskLedger is
  // NOT — the native repl() session and each headless rlm run each keep their own blackboard
  // (v5 parity: per-run ledger). Claims/coalescing reset at that boundary, by design.
  // The consolidation LLM + real workspace root are attached in session_start (setLlm/setRoot).
  const memory = new MemoryStore(
    process.cwd(),
    {
      dir: config.memoryDir ?? undefined,
      injectNoteTokens: config.injectNoteTokens,
      evolveEvery: config.evolveEvery,
    },
    config.enableMemory,
  );
  const controller = new RlmController(config, memory);
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
  // v5: sub-call admission is built per session (see session_start) so provider concurrency
  // caps resolve against the models actually in use.
  const background = new BackgroundTasks({
    maxTimeoutMs: config.maxTimeoutMs,
    maxTokens: config.maxTokens,
    maxErrors: config.maxErrors,
  });
  // A detached child works in its OWN sandbox, so this one sees no frames and its request
  // watchdog would fire mid-await and SIGKILL a healthy worker, taking the REPL namespace
  // with it. Keep it alive while detached work is genuinely in flight.
  const watchdogHeartbeat = setInterval(() => {
    if (background.pending > 0) sandboxManager.refreshWatchdog();
  }, SANDBOX_WATCHDOG_HEARTBEAT_MS);
  watchdogHeartbeat.unref();

  /** Memoised cwd seed — one resolveSource(pathPrefix:"") per session. */
  let seedPromise: Promise<void> | undefined;
  let cwdSeeded = false;
  /** Live add_context bundle — seed plants the "" sentinel here so add_context(".") is a no-op. */
  let contextBundleRef: AddContextHandlerBundle | undefined;
  /**
   * Payload identity last injected into the context hook. Re-inject only when the payload
   * reference changes (seed, add_context, reset) — not every turn. Keeps the root window small.
   */
  let listingPayloadRef: unknown = undefined;
  let listingInjected = false;
  const seedContext = async (cwd: string): Promise<void> => {
    if (cwdSeeded) return;
    if (!controller.config.autoSeedCwd) {
      cwdSeeded = true;
      return;
    }
    seedPromise ??= resolveSource(cwd, { cwd, pathPrefix: "" })
      .then((result) => {
        // Sticky either way: a failed seed must not re-walk the whole repo on every repl().
        cwdSeeded = true;
        if (!result.ok) {
          console.warn(`[rlm] context seed failed: ${result.error}`);
          return;
        }
        sandboxManager.contextPayload = result.value.payload;
        // Register the cwd seed with the bridge so add_context(".") cannot double the tree.
        contextBundleRef?.markSeededCwd(resolve(cwd));
      })
      .finally(() => { seedPromise = undefined; });
    await seedPromise;
  };

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
    // Re-read settings fresh from disk each session so a pin or config change
    // made during a previous session takes effect.
    const persisted = await loadSettings();
    controller.config = mergeConfig(persisted.config);
    controller.savedLlmRef = persisted.llm ?? undefined;

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

    if (controller.savedLlmRef) {
      const resolved = resolveModelId(ctx.modelRegistry, controller.savedLlmRef);
      if (resolved) {
        controller.llmModel = resolved;
      } else {
        // Keep the pin on disk/controller — do not fall back permanently. Runtime uses
        // cheapest until the catalog has the model again; surface that once per session.
        console.warn(
          `[rlm] pinned sub-LLM ${controller.savedLlmRef} not in registry; using cheapest until it reappears`,
        );
        try {
          ctx.ui.notify(
            `RLM: pinned llm=${controller.savedLlmRef} unavailable — using cheapest until it is`,
            "warning",
          );
        } catch {
          // Some hosts have no UI at session_start.
        }
      }
    }

    // Re-register repl tool each session to pick up model provider changes
    const llmModel = controller.llmModel ?? cheapestModel(ctx.modelRegistry) ?? ctx.model;
    const model = ctx.model;
    if (llmModel && model) {
      // Consolidation runs on the cheap worker model through the single completion entry point;
      // the workspace root is only known once the session starts.
      const consolidateModel = llmModel;
      memory.setLlm((prompt) =>
        modelComplete([{ role: "user", content: prompt }], { model: consolidateModel, registry: ctx.modelRegistry })
          .then((r) => r.text));
      memory.setRoot(ctx.cwd ?? process.cwd());
      // v5 provider caps (audit C1/C6): ONE resolver shared by both composition roots — the
      // repl() tool and RlmController.start admit through the same pool, each gate capped
      // against the model that actually runs on it (leaves = worker, children = smart).
      // Memoized on (config, providers) so /rlm-config changes apply without a restart.
      let gatesMemo:
        | { readonly config: RlmConfig; readonly smart: string; readonly worker: string; readonly gates: SubcallGates }
        | undefined;
      const resolveSessionGates = (): SubcallGates => {
        const smart = model;
        const worker = controller.llmModel ?? cheapestModel(ctx.modelRegistry) ?? model;
        const workerProvider = worker.provider;
        if (
          gatesMemo === undefined ||
          gatesMemo.config !== controller.config ||
          gatesMemo.smart !== smart.provider ||
          gatesMemo.worker !== workerProvider
        ) {
          gatesMemo = {
            config: controller.config,
            smart: smart.provider,
            worker: workerProvider,
            gates: buildSessionGates(controller.config, smart.provider, workerProvider),
          };
        }
        return gatesMemo.gates;
      };
      controller.setSessionGates(resolveSessionGates);
      try {
        pi.registerTool(createReplTool({
          sandboxManager,
          model,
          llmModel,
          getModel: () => controller.resolveModels(ctx)?.model,
          getLlmModel: () => controller.resolveModels(ctx)?.llm,
          registry: ctx.modelRegistry,
          getConfig: () => controller.config,
          gates: resolveSessionGates(),
          resolveGates: resolveSessionGates,
          background,
          memory,
          registerDiscardHook: (reset) => { onSandboxDiscardExtra = reset; },
          registerContextBundle: (bundle) => {
            contextBundleRef = bundle;
            // Tool re-registers each session; re-plant sentinel if seed already landed.
            if (cwdSeeded && Array.isArray(sandboxManager.contextPayload)
              && sandboxManager.contextPayload.length > 0) {
              bundle.markSeededCwd(resolve(ctx.cwd ?? process.cwd()));
            }
          },
          ensureContext: async () => {
            await seedContext(ctx.cwd ?? process.cwd());
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

  /** True when the native-mode trade holds: enabled AND repl is in the active tool set. */
  const nativeTradeHolds = (): boolean =>
    shouldEnforceNativeReaderBlock({
      enabled: controller.enabled,
      activeToolNames: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined,
    });

  // ── System prompt: native RLM mode addendum (only when the trade holds) ──
  pi.on("before_agent_start", async (event) => {
    if (!nativeTradeHolds()) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + buildNativeSystemPrompt() };
  });

  // ── Context injection: listing of whatever is currently loaded ──
  // Re-inject only when the payload identity changes (seed / add_context), not every turn —
  // the listing can be up to 200 file lines and the plugin exists to shrink the root window.
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (message) =>
        !(message.role === "custom" && message.customType === "rlm-intro")

    );
    if (!nativeTradeHolds()) return { messages: filtered };

    type PiMessage = (typeof filtered)[number];

    const payload = sandboxManager.contextPayload;
    if (!listingInjected || payload !== listingPayloadRef) {
      listingInjected = true;
      listingPayloadRef = payload;
      const listing = formatContextListing(payload);
      const instruction = [
        "Prefer repl({code}) for bulk analysis: free search/grep/outline, then fan-out Tasks.",
        "Multi-module work → rlm_batch (or rlm_query); one-shot extracts → map_files/llm_batch.",
        "Always-spawn returns Task (↯bg); only await_task has content — fire-all then await.",
        "Large tool/repl outputs are capped. Files live in REPL `context` (cwd seeds first repl()).",
        "add_context(path) for external dirs/files/docs/git. Credits exhausted → report and stop.",
        "",
      ].join("\n");
      filtered.unshift({
        role: "user" as const,
        content: instruction + listing,
        timestamp: 0,
      } as PiMessage);
    }


    return { messages: filtered };
  });

  // Soft token guard only — never hard-block read/grep/bash. Large tool results are capped.
  // After edit/write, re-read disk into RLM context so search/llm see fresh content.
  const MUTATING_FILE_TOOLS = Object.freeze(new Set(["edit", "write"]));

  pi.on("tool_result", async (event, ctx) => {
    // ── Keep RLM context fresh after native file mutations ──
    if (
      nativeTradeHolds()
      && MUTATING_FILE_TOOLS.has(event.toolName)
      && event.isError !== true
    ) {
      const cwd = resolve(ctx?.cwd ?? process.cwd());
      const paths = extractEditPaths(event.input);
      for (const p of paths) {
        const body = await readDiskFile(p, cwd);
        if (body === null) continue;
        try {
          await sandboxManager.refreshFileFromDisk(p, body, cwd);
          // Listing must re-inject if we rewrote payload identity
          listingPayloadRef = undefined;
        } catch (err) {
          if (traceEnabled) {
            trace("context.refresh_fail", { path: p, error: errorMessage(err) });
          }
        }
      }
    }

    if (!nativeTradeHolds() || !CAPPED_RESULT_TOOLS.has(event.toolName)) return;
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
    cwdSeeded = false;
    seedPromise = undefined;
    contextBundleRef = undefined;
    listingPayloadRef = undefined;
    listingInjected = false;
    sandboxManager.contextPayload = [];
  });
}
