/**
 * Native Pi confirm dialog for proposed edits.
 *
 * Replaces the former custom TUI overlay: diff generation uses Pi's
 * generateUnifiedPatch() and colouring uses Pi's renderDiff(). The only
 * custom logic left is assembling the preview text from the two edit kinds.
 */

import { generateUnifiedPatch, renderDiff, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";

function buildPreviewText(
  edits: readonly ProposedEdit[],
  diffs: readonly ProposedDiffEdit[],
): string {
  const parts = new Array<string>(edits.length + diffs.length);
  let i = 0;
  for (const edit of edits) {
    try {
      parts[i++] = generateUnifiedPatch(edit.path, edit.oldText, edit.newText);
    } catch {
      parts[i++] = `(failed to diff ${edit.path})`;
    }
  }
  for (const diff of diffs) {
    parts[i++] = diff.diff;
  }
  return parts.join("\n");
}

export async function showEditConfirm(
  edits: readonly ProposedEdit[],
  diffs: readonly ProposedDiffEdit[],
  ctx: ExtensionContext,
): Promise<boolean> {
  const editCount = edits.length + diffs.length;
  const preview = renderDiff(buildPreviewText(edits, diffs));
  return ctx.ui.confirm(
    `RLM proposed ${editCount} edit${editCount !== 1 ? "s" : ""} — apply?`,
    preview,
  );
}
