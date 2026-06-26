import type { ProposedEdit } from "../sandbox/protocol.ts";
import { parseUnifiedDiff } from "./unified-diff.ts";

export interface EditGroup {
  readonly path: string;
  readonly edits: ProposedEdit[];
}

export interface EditRequestPreview {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly validationPreview: string;
}

export interface DiffEditRequestPreview {
  readonly diff: string;
  readonly validationPreview: string;
}

export function groupEdits(edits: readonly ProposedEdit[]): EditGroup[] {
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

function appendEditPreview(lines: string[], oldText: string, newText: string): void {
  lines.push("```diff");
  lines.push(`- ${previewBlock(oldText).replaceAll("\n", "\n- ")}`);
  lines.push(`+ ${previewBlock(newText).replaceAll("\n", "\n+ ")}`);
  lines.push("```");
}

function appendUnifiedDiffPreview(lines: string[], diff: string): void {
  lines.push("```diff");
  lines.push(previewBlock(diff));
  lines.push("```");
}

export function renderEditSummary(groups: readonly EditGroup[]): string {
  const lines = [
    `RLM proposed ${groups.reduce((n, group) => n + group.edits.length, 0)} edit(s) across ${groups.length} file(s).`,
    "",
  ];
  for (const group of groups) {
    lines.push(`### ${group.path}`);
    for (let i = 0; i < group.edits.length; i++) {
      const edit = group.edits[i];
      if (edit === undefined) continue;
      lines.push(`- Edit ${i + 1}: −${lineCount(edit.oldText)}/+${lineCount(edit.newText)} lines`);
      appendEditPreview(lines, edit.oldText, edit.newText);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderUnifiedDiffSummary(diff: string): string {
  const parsed = parseUnifiedDiff(diff);
  const lines = ["RLM proposed unified diff edits.", ""];
  if (parsed.ok) {
    lines.push(`Files: ${parsed.files.length}`);
    for (const file of parsed.files) {
      let additions = 0;
      let removals = 0;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === "add") additions++;
          else if (line.kind === "remove") removals++;
        }
      }
      lines.push(`- ${file.path}: ${file.hunks.length} hunk(s), −${removals}/+${additions} lines`);
    }
  } else {
    lines.push(`Parse warning: ${parsed.error}`);
  }
  lines.push("");
  appendUnifiedDiffPreview(lines, diff);
  return lines.join("\n");
}

export function renderEditRequestPreview(request: EditRequestPreview): string {
  const lines = [
    `RLM requests permission to record an edit for:`,
    "",
    `**${request.path}**`,
    "",
    `Validation: ${request.validationPreview}`,
    `Size: −${lineCount(request.oldText)}/+${lineCount(request.newText)} lines`,
    "",
  ];
  appendEditPreview(lines, request.oldText, request.newText);
  return lines.join("\n");
}

export function renderUnifiedDiffRequestPreview(request: DiffEditRequestPreview): string {
  const lines = [
    "RLM requests permission to record a unified diff edit:",
    "",
    `Validation: ${request.validationPreview}`,
    "",
    renderUnifiedDiffSummary(request.diff),
  ];
  return lines.join("\n");
}
