/** `/rlm` — toggle persistent Recursive Language Model mode. */

import { readFile, stat, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeWorkspaceRealPath } from "../bridge/fs-tools.ts";
import type { RlmController, RunHandle } from "../mode/rlm-mode.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import { applyAnchorEdits, type AnchorEdit } from "../text/edits.ts";
import { groupEdits, renderEditSummary, type EditGroup } from "../text/edit-preview.ts";
import { postRlmGuide } from "../ui/intro.ts";
import { clearRlmStatus, setRlmModeStatus } from "../ui/status.ts";
import { listRunIds, readContextSidecar, readHeader, resolveRunId } from "../state/index.ts";
import { DEFAULT_RUN_DIR } from "../config/defaults.ts";
import { reconstructRlmState } from "../state/resume.ts";
import type { ReconstructResult } from "../state/resume.ts";
import type { RunHeader } from "../state/rows.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { RlmToolBridge } from "../tool/rlm-details.ts";
import { createTelemetrySink } from "../telemetry/index.ts";

interface PreparedFileEdit {
  readonly ok: true;
  readonly path: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly count: number;
}

interface SkippedFileEdit {
  readonly ok: false;
  readonly path: string;
  readonly error: string;
}

interface AppliedFileEdit {
  readonly path: string;
  readonly count: number;
}

async function prepareFileEdit(cwd: string, group: EditGroup, maxReadBytes: number): Promise<PreparedFileEdit | SkippedFileEdit> {
  let absolutePath: string;
  try {
    absolutePath = await safeWorkspaceRealPath(cwd, group.path);
  } catch (error) {
    return { ok: false, path: group.path, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const st = await stat(absolutePath);
    if (!st.isFile()) return { ok: false, path: group.path, error: `'${group.path}' is not a file` };
    if (st.size > maxReadBytes) return { ok: false, path: group.path, error: `file exceeds the ${maxReadBytes} byte limit` };
    const text = await readFile(absolutePath, "utf8");
    const anchors: AnchorEdit[] = group.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText }));
    const applied = applyAnchorEdits(text, group.path, anchors);
    if (!applied.ok) return { ok: false, path: group.path, error: applied.error };
    return { ok: true, path: group.path, absolutePath, content: applied.text, count: applied.applied };
  } catch (error) {
    return { ok: false, path: group.path, error: error instanceof Error ? error.message : String(error) };
  }
}

function skippedSummary(skipped: readonly SkippedFileEdit[]): string {
  if (skipped.length === 0) return "";
  const shown = skipped.slice(0, 3).map((item) => `${item.path}: ${item.error}`).join("; ");
  const suffix = skipped.length > 3 ? `; +${skipped.length - 3} more` : "";
  return ` Skipped ${skipped.length} file(s): ${shown}${suffix}`;
}

async function applyProposedEdits(controller: RlmController, ctx: ExtensionContext, resultEdits: readonly ProposedEdit[]): Promise<void> {
  if (!controller.config.editEnabled || resultEdits.length === 0) return;
  const groups = groupEdits(resultEdits);
  const summary = renderEditSummary(groups);
  const apply = ctx.hasUI
    ? await ctx.ui.confirm("Apply RLM edits?", summary)
    : false;
  if (!apply) {
    ctx.ui.notify("RLM edits were proposed but not applied.", "info");
    return;
  }

  const applied: AppliedFileEdit[] = [];
  const skipped: SkippedFileEdit[] = [];
  for (const group of groups) {
    const prepared = await prepareFileEdit(ctx.cwd, group, controller.config.fsLimits.maxReadBytes);
    if (!prepared.ok) {
      skipped.push(prepared);
      continue;
    }
    try {
      await writeFile(prepared.absolutePath, prepared.content, "utf8");
      applied.push({ path: prepared.path, count: prepared.count });
    } catch (error) {
      skipped.push({ path: prepared.path, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const editCount = applied.reduce((sum, file) => sum + file.count, 0);
  const level = applied.length > 0 ? "info" : "error";
  ctx.ui.notify(`Applied ${editCount} RLM edit(s) across ${applied.length} file(s).${skippedSummary(skipped)}`, level);
}

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
        { contextType: header.context.type, contextChars: header.context.chars, rootPrompt: header.rootPrompt, workspaceRoot: header.workspaceRoot, fsTools: header.meta.fsTools, projectMap: header.context.projectMap },
        { orchestrator: header.meta.orchestrator, recursion: 1 < header.meta.maxDepth, edit: header.meta.editEnabled }, // CB: 1 < maxDepth, not hardcoded true
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
  try {
    sink = await createTelemetrySink(controller.config.telemetry);
    const bridge = new RlmToolBridge((partial) => {
      const d = partial.details;
      if (!d) return;
      const turn = d.turns.max > 0 ? ` · turn ${d.turns.current}/${d.turns.max}` : "";
      const cost = d.totals.costUsd > 0 ? ` · $${d.totals.costUsd.toFixed(4)}` : "";
      const glyph = d.status === "running" ? "⏳" : d.status === "done" ? "✓" : "✗";
      ctx.ui.setWidget?.("rlm-status", [`${glyph} RLM resume${turn}${cost}`], { placement: "aboveEditor" });
    }, sink);
    bridge.setRootPrompt(header.rootPrompt);
    handle = controller.start(ctx, { kind: "resume", resume: recon, context }, bridge);
  } catch (e) {
    ctx.ui.notify(`RLM resume failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  pi.sendMessage({ customType: "rlm-question", content: `[resume] ${header.rootPrompt}`, display: true });
  const { done } = handle;
  try {
    const result = await done;
    pi.sendMessage({ customType: "rlm-answer", content: result.answer, display: true });
    if (result.edits && result.edits.length > 0) {
      pi.sendMessage({ customType: "rlm-answer", content: renderEditSummary(groupEdits(result.edits)), display: true });
      await applyProposedEdits(controller, ctx, result.edits);
    }
  } catch (e) {
    ctx.ui.notify(`RLM resume failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    clearRlmStatus(ctx.ui);
    ctx.ui.setWidget?.("rlm-status", undefined);
    try { await sink?.shutdown(); } catch { /* best-effort */ }
  }
}
