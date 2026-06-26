/** `/rlm` — toggle persistent Recursive Language Model mode. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import type { RlmController, RunHandle } from "../mode/rlm-mode.ts";
import { postRlmGuide } from "../ui/intro.ts";
import { clearRlmStatus, setRlmModeStatus } from "../ui/status.ts";
import { listRunIds, readContextSidecar, readHeader, resolveRunId } from "../state/index.ts";
import { DEFAULT_RUN_DIR } from "../config/defaults.ts";
import { reconstructRlmState } from "../state/resume.ts";
import type { ReconstructResult } from "../state/resume.ts";
import type { RunHeader } from "../state/rows.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { RlmEmitter } from "../tool/rlm-events.ts";
import { RlmEventAggregator } from "../tool/rlm-aggregator.ts";
import { createTelemetrySink } from "../telemetry/index.ts";

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Toggle persistent RLM mode (route plain prompts through the RLM engine).",
    handler: async (_args, ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("rlm-stop", {
    description: "Abort the in-progress RLM run.",
    handler: async (_args, ctx) => {
      if (!controller.isBusy()) {
        ctx.ui.notify("No RLM run in progress.", "info");
        return;
      }
      controller.abort();
      ctx.ui.notify("RLM run aborted.", "info");
    },
  });

  pi.registerCommand("rlm-help", {
    description: "Show the RLM startup guide and command cheatsheet.",
    handler: async () => {
      postRlmGuide(pi, controller);
    },
  });

  pi.registerCommand("rlm-resume", {
    description: "Resume an interrupted RLM run (default @latest).",
    handler: async (args, ctx) => {
      if (controller.isBusy()) {
        ctx.ui.notify("RLM is busy (use /rlm-stop to cancel).", "warning");
        return;
      }
      const ref = args.trim() || "@latest";
      const dir = controller.config.runLog?.dir ?? DEFAULT_RUN_DIR;
      const cwd = ctx.cwd ?? process.cwd();
      const runId = resolveRunId(cwd, dir, ref);
      if (!runId) { ctx.ui.notify(`No resumable RLM run for '${ref}'.`, "error"); return; }
      const header = readHeader(cwd, dir, runId);
      if (!header) { ctx.ui.notify(`Run ${runId} has no header.`, "error"); return; }
      const systemPrompt = buildRlmSystemPrompt(
        { contextType: header.context.type, contextChars: header.context.chars, rootPrompt: header.rootPrompt },
        {
          orchestrator: header.meta.orchestrator,
          recursion: 1 < header.meta.maxDepth,
          askUserQuestion: controller.config.askUserQuestion,
          todo: controller.config.todo,
        },
      );
      let recon: ReconstructResult;
      try { recon = reconstructRlmState(cwd, dir, runId, systemPrompt); }
      catch (e) {
        ctx.ui.notify(`RLM resume failed: corrupt run state — ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      if (!recon.ok) { ctx.ui.notify(`Cannot resume ${runId}: ${recon.reason}.`, "error"); return; }
      if (recon.terminated) { ctx.ui.notify(`Run ${runId} already finished.`, "info"); return; }
      const context = readContextSidecar(cwd, dir, runId, header.context.json);
      if (context === undefined) // R-C2: warn instead of silently resuming on empty context
        ctx.ui.notify(`Warning: context sidecar missing for ${runId} — resuming without original context.`, "warning");
      await executeRlmRunWithResume(pi, controller, ctx, recon, header, context ?? "");
    },
  });

  pi.registerCommand("rlm-runs", {
    description: "List recent RLM runs.",
    handler: async (_args, ctx) => {
      const dir = controller.config.runLog?.dir ?? DEFAULT_RUN_DIR;
      const ids = listRunIds(ctx.cwd ?? process.cwd(), dir).slice(0, 20);
      ctx.ui.notify(ids.length ? ids.join("\n") : "No RLM runs recorded.", "info");
    },
  });

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode (off also stops a running query)",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}

async function executeRlmRunWithResume(
  pi: ExtensionAPI,
  controller: RlmController,
  ctx: ExtensionContext,
  recon: ReconstructResult & { ok: true },
  header: RunHeader,
  context: unknown,
): Promise<void> {
  let handle: RunHandle | undefined;
  let sink: Awaited<ReturnType<typeof createTelemetrySink>>;
  let emitter: RlmEmitter | undefined;
  let detachSink: (() => void) | undefined;
  let aggregator: RlmEventAggregator | undefined;
  try {
    sink = await createTelemetrySink(controller.config.telemetry);
    emitter = new RlmEmitter();
    if (sink) detachSink = emitter.attachSink(sink);
    aggregator = new RlmEventAggregator(emitter, (partial) => {
      const d = partial.details;
      if (!d) return;
      const turn = d.turns.max > 0 ? ` · turn ${d.turns.current}/${d.turns.max}` : "";
      const cost = d.totals.costUsd > 0 ? ` · $${d.totals.costUsd.toFixed(4)}` : "";
      const glyph = d.status === "running" ? "⏳" : d.status === "done" ? "✓" : "✗";
      ctx.ui.setWidget?.("rlm-status", [`${glyph} RLM resume${turn}${cost}`], { placement: "aboveEditor" });
    });
    emitter.emitRootPrompt(header.rootPrompt);
    const interactive = createPiInteractiveDeps(ctx);
    if (controller.config.todo) {
      for (const row of recon.todoRows) await interactive.onTodo?.(row.action, row.params);
    }
    handle = controller.start(ctx, { kind: "resume", resume: recon, context }, emitter, {
      onAskUserQuestion: controller.config.askUserQuestion ? interactive.onAskUserQuestion : undefined,
      onTodo: controller.config.todo ? interactive.onTodo : undefined,
    });
  } catch (e) {
    ctx.ui.notify(`RLM resume failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  pi.sendMessage({ customType: "rlm-question", content: `[resume] ${header.rootPrompt}`, display: true });
  const { done } = handle;
  try {
    const result = await done;
    pi.sendMessage({ customType: "rlm-answer", content: result.answer, display: true });
    // Edits and diffs are no longer applied — fs tools are removed in paper mode.
  } catch (e) {
    ctx.ui.notify(`RLM resume failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    clearRlmStatus(ctx.ui);
    ctx.ui.setWidget?.("rlm-status", undefined);
    detachSink?.();
    aggregator?.dispose();
    emitter?.shutdown();
    try { await sink?.shutdown(); } catch { /* best-effort */ }
  }
}
