import type { ProposedEdit } from "../sandbox/protocol.ts";

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

export function renderEditSummary(groups: readonly EditGroup[]): string {
  const lines = [
    `RLM proposed ${groups.reduce((n, group) => n + group.edits.length, 0)} edit(s) across ${groups.length} file(s).`,
    "",
  ];
  for (const group of groups) {
    lines.push(`### ${group.path}`);
    group.edits.forEach((edit, index) => {
      lines.push(`- Edit ${index + 1}: −${lineCount(edit.oldText)}/+${lineCount(edit.newText)} lines`);
      appendEditPreview(lines, edit.oldText, edit.newText);
    });
    lines.push("");
  }
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
