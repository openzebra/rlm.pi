import { createEditToolDefinition, type AgentToolResult, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EditRegistry } from "../registry/edit-registry.ts";
import { planEdit } from "../text/edits.ts";
import { errorMessage, formatError } from "../util/errors.ts";

export const ApplyEditsToolParams = Object.freeze(Type.Object({
  ids: Type.Array(Type.String({ description: "A staged edit ID returned by stage_edit()." }), {
    description: "Staged edit IDs to apply.",
  }),
}));

export interface ApplyEditsFailure {
  readonly id: string;
  readonly path: string;
  readonly error: string;
}

export interface ApplyEditsPatch {
  readonly oldText: string;
  readonly newText: string;
}

export interface ApplyEditsFileStat {
  readonly path: string;
  readonly status: "applied" | "failed";
  readonly added: number;
  readonly removed: number;
  readonly edits: readonly ApplyEditsPatch[];
}

export interface ApplyEditsDetails {
  readonly status: "done" | "partial" | "error";
  readonly appliedCount: number;
  readonly failedCount: number;
  readonly errors: readonly ApplyEditsFailure[];
  readonly fileStats: readonly ApplyEditsFileStat[];
}

export interface LineStats {
  readonly added: number;
  readonly removed: number;
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function diffStats(before: string, after: string): LineStats {
  const beforeLineCount = countLines(before);
  const afterLineCount = countLines(after);
  return Object.freeze({
    added: Math.max(0, afterLineCount - beforeLineCount),
    removed: Math.max(0, beforeLineCount - afterLineCount),
  });
}

function statusFor(appliedCount: number, failedCount: number): ApplyEditsDetails["status"] {
  if (failedCount === 0 && appliedCount > 0) return "done";
  return appliedCount > 0 ? "partial" : "error";
}

function aggregateLineStats(fileStats: readonly ApplyEditsFileStat[]): LineStats {
  let added = 0;
  let removed = 0;
  for (let i = 0; i < fileStats.length; i++) {
    const stat = fileStats[i];
    added += stat.added;
    removed += stat.removed;
  }
  return Object.freeze({ added, removed });
}

function appendPatch(existing: readonly ApplyEditsPatch[], patch: ApplyEditsPatch | undefined): readonly ApplyEditsPatch[] {
  if (patch === undefined) return existing;
  const patches = new Array<ApplyEditsPatch>(existing.length + 1);
  for (let i = 0; i < existing.length; i++) {
    patches[i] = existing[i];
  }
  patches[existing.length] = patch;
  return Object.freeze(patches);
}

function mergeFileStat(
  fileStatsByPath: Map<string, ApplyEditsFileStat>,
  path: string,
  status: ApplyEditsFileStat["status"],
  stats: LineStats,
  patch?: ApplyEditsPatch,
): void {
  const existing = fileStatsByPath.get(path);
  const nextStatus: ApplyEditsFileStat["status"] = existing?.status === "failed" || status === "failed" ? "failed" : "applied";
  fileStatsByPath.set(path, {
    path,
    status: nextStatus,
    added: (existing?.added ?? 0) + stats.added,
    removed: (existing?.removed ?? 0) + stats.removed,
    edits: appendPatch(existing?.edits ?? Object.freeze([]), patch),
  });
}

function renderLineStats(stats: LineStats, theme: Theme): string {
  return `${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)} lines`;
}

function formatEditCounts(details: ApplyEditsDetails): string {
  return details.failedCount > 0
    ? `${details.appliedCount} applied, ${details.failedCount} failed`
    : `${details.appliedCount} applied`;
}

function formatFileCount(fileCount: number): string {
  return `${fileCount} file${fileCount === 1 ? "" : "s"}`;
}

function summarizeFiles(details: ApplyEditsDetails): string {
  return `apply_edits: ${formatFileCount(details.fileStats.length)}, ${formatEditCounts(details)}`;
}

function summarize(details: ApplyEditsDetails): string {
  const stats = aggregateLineStats(details.fileStats);
  const head = `${summarizeFiles(details)} (+${stats.added} -${stats.removed} lines)`;
  if (details.errors.length === 0) return `${head}.`;
  const rows = new Array<string>(details.errors.length);
  for (let i = 0; i < details.errors.length; i++) {
    const error = details.errors[i];
    rows[i] = `${error.id}: ${error.error}`;
  }
  return `${head}.\n${rows.join("\n")}`;
}

function renderCollapsed(details: ApplyEditsDetails, theme: Theme): Text {
  const stats = aggregateLineStats(details.fileStats);
  const statusColor = details.status === "error" ? "error" : "success";
  return new Text(`${theme.fg(statusColor, summarizeFiles(details))} ${renderLineStats(stats, theme)}`, 0, 0);
}

function renderFileLine(fileStat: ApplyEditsFileStat, theme: Theme): Text {
  const glyph = fileStat.status === "applied" ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const stats = renderLineStats(fileStat, theme);
  return new Text(`${glyph} ${theme.fg("dim", fileStat.path)} ${stats}`, 0, 0);
}

function limitPatchText(text: string): string {
  const maxChars = 2_000;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function renderPatchLines(text: string, prefix: string, color: "error" | "success", theme: Theme): string {
  const limitedText = limitPatchText(text);
  const lines = limitedText.split("\n");
  const rendered = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    rendered[i] = theme.fg(color, `${prefix}${lines[i]}`);
  }
  return rendered.join("\n");
}

function renderPatch(patch: ApplyEditsPatch, theme: Theme): Text {
  const oldText = patch.oldText.length === 0 ? "(new file)" : patch.oldText;
  const text = [
    theme.fg("error", "--- old"),
    renderPatchLines(oldText, "- ", "error", theme),
    theme.fg("success", "+++ new"),
    renderPatchLines(patch.newText, "+ ", "success", theme),
  ].join("\n");
  return new Text(text, 2, 0);
}

function renderExpanded(details: ApplyEditsDetails, theme: Theme): Container {
  const container = new Container();
  const header = summarizeFiles(details);
  const headerColor = details.status === "error" ? "error" : "success";
  container.addChild(new Text(theme.fg(headerColor, header), 0, 0));
  for (let i = 0; i < details.fileStats.length; i++) {
    const fileStat = details.fileStats[i];
    container.addChild(renderFileLine(fileStat, theme));
    for (let editIndex = 0; editIndex < fileStat.edits.length; editIndex++) {
      container.addChild(renderPatch(fileStat.edits[editIndex], theme));
    }
  }
  if (details.errors.length > 0) {
    const rows = new Array<string>(details.errors.length);
    for (let i = 0; i < details.errors.length; i++) {
      const error = details.errors[i];
      rows[i] = `${error.id}: ${error.error}`;
    }
    container.addChild(new Text(theme.fg("error", rows.join("\n")), 0, 0));
  }
  return container;
}

export function createApplyEditsTool(editRegistry: EditRegistry): ToolDefinition<typeof ApplyEditsToolParams, ApplyEditsDetails> {
  return {
    name: "apply_edits",
    label: "Apply Edits",
    description: "Apply staged REPL edits by ID without re-typing file paths or edit bodies.",
    parameters: ApplyEditsToolParams,

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ApplyEditsDetails>> {
      const errors = new Array<ApplyEditsFailure>(params.ids.length);
      const fileStatsByPath = new Map<string, ApplyEditsFileStat>();
      let appliedCount = 0;
      let failedCount = 0;
      // Native mode: plan/validate with shared planEdit, then write through the host
      // edit tool so file-watcher / undo hooks still fire (direct write for create only).
      const editTool = createEditToolDefinition(ctx.cwd);

      for (let i = 0; i < params.ids.length; i++) {
        const id = params.ids[i];
        const edit = editRegistry.get(id);
        if (edit === undefined) {
          errors[failedCount] = { id, path: id, error: formatError("unknown edit id") };
          mergeFileStat(fileStatsByPath, id, "failed", { added: 0, removed: 0 });
          failedCount++;
          continue;
        }

        const planned = await planEdit(ctx.cwd, edit.path, edit.oldText, edit.newText);
        if (!planned.ok) {
          errors[failedCount] = { id, path: edit.path, error: planned.error };
          mergeFileStat(fileStatsByPath, edit.path, "failed", { added: 0, removed: 0 }, { oldText: edit.oldText, newText: edit.newText });
          failedCount++;
          continue;
        }

        try {
          if (planned.kind === "already-applied") {
            mergeFileStat(fileStatsByPath, edit.path, "applied", { added: 0, removed: 0 }, { oldText: edit.oldText, newText: edit.newText });
            editRegistry.delete(id);
            appliedCount++;
            continue;
          }
          if (planned.kind === "create") {
            const fullPath = resolve(ctx.cwd, edit.path);
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, planned.after, "utf8");
          } else {
            await editTool.execute(
              toolCallId,
              { path: edit.path, edits: [{ oldText: edit.oldText, newText: edit.newText }] },
              signal,
              undefined,
              ctx,
            );
          }
          mergeFileStat(
            fileStatsByPath,
            edit.path,
            "applied",
            diffStats(planned.before, planned.after),
            { oldText: edit.oldText, newText: edit.newText },
          );
          editRegistry.delete(id);
          appliedCount++;
        } catch (error: unknown) {
          errors[failedCount] = { id, path: edit.path, error: formatError(errorMessage(error)) };
          mergeFileStat(fileStatsByPath, edit.path, "failed", { added: 0, removed: 0 }, { oldText: edit.oldText, newText: edit.newText });
          failedCount++;
        }
      }

      const fileStats = new Array<ApplyEditsFileStat>(fileStatsByPath.size);
      let fileStatIndex = 0;
      for (const stat of fileStatsByPath.values()) {
        fileStats[fileStatIndex] = stat;
        fileStatIndex++;
      }

      const details = Object.freeze({
        status: statusFor(appliedCount, failedCount),
        appliedCount,
        failedCount,
        errors: Object.freeze(errors.slice(0, failedCount)),
        fileStats: Object.freeze(fileStats),
      });
      return { content: [{ type: "text", text: summarize(details) }], details };
    },

    renderCall(args, theme) {
      const editCount = args.ids.length;
      const summary = `apply_edits: ${editCount} edit${editCount === 1 ? "" : "s"}`;
      return new Text(theme.fg("toolTitle", theme.bold(summary)), 0, 0);
    },

    renderResult(result, options, theme): Component {
      const details = result.details;
      if (details === undefined) return new Text("(no apply_edits details)", 0, 0);
      return options.expanded ? renderExpanded(details, theme) : renderCollapsed(details, theme);
    },
  };
}
