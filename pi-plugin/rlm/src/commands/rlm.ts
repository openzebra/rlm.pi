/** `/rlm` — toggle persistent Recursive Language Model mode. */

import { readFile, stat, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeWorkspaceRealPath } from "../bridge/fs-tools.ts";
import type { RlmController } from "../mode/rlm-mode.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import { applyAnchorEdits, type AnchorEdit } from "../text/edits.ts";
import { postRlmGuide } from "../ui/intro.ts";
import { clearRlmStatus, setRlmModeStatus } from "../ui/status.ts";
import { createTreeWidget } from "../ui/tree-widget.ts";

interface EditGroup {
  readonly path: string;
  readonly edits: ProposedEdit[];
}

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

function groupEdits(edits: readonly ProposedEdit[]): EditGroup[] {
  const byPath = new Map<string, ProposedEdit[]>();
  for (const edit of edits) {
    const group = byPath.get(edit.path);
    if (group) group.push(edit);
    else byPath.set(edit.path, [edit]);
  }
  return Array.from(byPath, ([path, group]) => ({ path, edits: group }));
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function previewBlock(text: string): string {
  const limit = 700;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function renderEditSummary(groups: readonly EditGroup[]): string {
  const lines = [
    `RLM proposed ${groups.reduce((n, group) => n + group.edits.length, 0)} edit(s) across ${groups.length} file(s).`,
    "",
  ];
  for (const group of groups) {
    lines.push(`### ${group.path}`);
    group.edits.forEach((edit, index) => {
      lines.push(`- Edit ${index + 1}: −${lineCount(edit.oldText)}/+${lineCount(edit.newText)} lines`);
      lines.push("```diff");
      lines.push(`- ${previewBlock(edit.oldText).replaceAll("\n", "\n- ")}`);
      lines.push(`+ ${previewBlock(edit.newText).replaceAll("\n", "\n+ ")}`);
      lines.push("```");
    });
    lines.push("");
  }
  return lines.join("\n");
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

export async function executeRlmRun(
  pi: ExtensionAPI,
  controller: RlmController,
  ctx: ExtensionContext,
  question: string,
  context: unknown,
  restoreModeStatus = true,
): Promise<void> {
  let handle;
  try {
    handle = controller.start(ctx, question, context);
  } catch (e) {
    ctx.ui.notify(`RLM failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }

  const { tree, done } = handle;
  ctx.ui.setWidget("rlm-tree", createTreeWidget(tree), { placement: "aboveEditor" });

  try {
    const result = await done;
    pi.sendMessage({
      customType: "rlm-answer",
      content: result.answer,
      display: true,
    });
    if (result.edits && result.edits.length > 0) {
      pi.sendMessage({
        customType: "rlm-answer",
        content: renderEditSummary(groupEdits(result.edits)),
        display: true,
      });
      await applyProposedEdits(controller, ctx, result.edits);
    }
  } catch (e) {
    ctx.ui.notify(`RLM failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    ctx.ui.setWidget("rlm-tree", undefined);
    if (restoreModeStatus) setRlmModeStatus(ctx.ui, controller);
    else clearRlmStatus(ctx.ui);
  }
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

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode (off also stops a running query)",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}
