/** `/rlm` — toggle persistent Recursive Language Model mode. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
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
import type { RlmDetails } from "../tool/rlm-details.ts";
import { cardHeader, cardStatsLine, renderCollapsedSubcallTree } from "../tool/subcall-render.ts";
import { errorMessage } from "../util/errors.ts";

/** Run ids offered for `/rlm-resume <TAB>`. */
const MAX_COMPLETIONS = 20;

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Toggle persistent RLM mode (route plain prompts through the RLM engine).",
    handler: async (_args, ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());
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
    getArgumentCompletions: async (prefix) => {
      const dir = controller.config.runLog?.dir ?? DEFAULT_RUN_DIR;
      const ids = await listRunIds(process.cwd(), dir);
      const candidates = ["@latest", ...ids];
      return candidates
        .filter((value) => value.startsWith(prefix))
        .slice(0, MAX_COMPLETIONS)
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (controller.isBusy()) {
        ctx.ui.notify("RLM is busy (use /rlm-stop to cancel).", "warning");
        return;
      }
      const ref = args.trim() || "@latest";
      const dir = controller.config.runLog?.dir ?? DEFAULT_RUN_DIR;
      const cwd = ctx.cwd ?? process.cwd();
      const runId = await resolveRunId(cwd, dir, ref);
      if (!runId) { ctx.ui.notify(`No resumable RLM run for '${ref}'.`, "error"); return; }
      const header = await readHeader(cwd, dir, runId);
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
      try { recon = await reconstructRlmState(cwd, dir, runId, systemPrompt); }
      catch (e) {
        ctx.ui.notify(`RLM resume failed: corrupt run state — ${errorMessage(e)}`, "error");
        return;
      }
      if (!recon.ok) { ctx.ui.notify(`Cannot resume ${runId}: ${recon.reason}.`, "error"); return; }
      if (recon.terminated) { ctx.ui.notify(`Run ${runId} already finished.`, "info"); return; }
      const context = await readContextSidecar(cwd, dir, runId, header.context.json);
      if (context === undefined) // R-C2: warn instead of silently resuming on empty context
        ctx.ui.notify(`Warning: context sidecar missing for ${runId} — resuming without original context.`, "warning");
      await executeRlmRunWithResume(pi, controller, ctx, recon, header, context ?? "");
    },
  });

  pi.registerCommand("rlm-runs", {
    description: "List recent RLM runs.",
    handler: async (_args, ctx) => {
      const dir = controller.config.runLog?.dir ?? DEFAULT_RUN_DIR;
      const ids = (await listRunIds(ctx.cwd ?? process.cwd(), dir)).slice(0, 20);
      ctx.ui.notify(ids.length ? ids.join("\n") : "No RLM runs recorded.", "info");
    },
  });

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode (off also stops a running query)",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller, ctx.getContextUsage());
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}

/** Above-editor progress card for a `/rlm-resume` run: header + the live sub-call tree. */
function renderResumeWidget(details: RlmDetails | undefined, theme: Theme): Component {
  const container = new Container();
  if (!details) return container;
  const turns = details.turns;
  const stats = cardStatsLine(
    details.totals,
    theme,
    turns.max > 0 ? `turn ${turns.current}/${turns.max}` : undefined,
  );
  container.addChild(new Text(cardHeader("RLM resume", details.status, stats, theme), 0, 0));
  if (details.subcalls.length > 0) {
    container.addChild(new Text(renderCollapsedSubcallTree(details.subcalls, theme), 0, 0));
  }
  return container;
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
  let emitter: RlmEmitter | undefined;
  let aggregator: RlmEventAggregator | undefined;
  try {
    emitter = new RlmEmitter();
    // Component factory rather than the string[] form: the array form is hard-capped at 10
    // lines by pi, which the live sub-call tree exceeds as soon as a run fans out. The factory
    // also receives the live theme, so the widget follows /theme switches.
    let latest: RlmDetails | undefined;
    aggregator = new RlmEventAggregator(emitter, (partial) => {
      latest = partial.details;
      if (!latest) return;
      ctx.ui.setWidget?.("rlm-status", (_tui, theme) => renderResumeWidget(latest, theme), {
        placement: "aboveEditor",
      });
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
    ctx.ui.notify(`RLM resume failed: ${errorMessage(e)}`, "error");
    return;
  }
  pi.sendMessage({ customType: "rlm-question", content: `[resume] ${header.rootPrompt}`, display: true });
  const { done } = handle;
  try {
    const result = await done;
    pi.sendMessage({ customType: "rlm-answer", content: result.answer, display: true });
  } catch (e) {
    ctx.ui.notify(`RLM resume failed: ${errorMessage(e)}`, "error");
  } finally {
    clearRlmStatus(ctx.ui);
    ctx.ui.setWidget?.("rlm-status", undefined);
    aggregator?.dispose();
    emitter?.shutdown();
  }
}
