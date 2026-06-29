/**
 * applyEdits — THE single call site for applying proposed edits/diffs.
 *
 * Both rlm-tool.ts and rlm.ts must call this and nothing else.
 * No duplication allowed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";
import { applyAnchorEdits, applyDiffEdits, type ApplyResult } from "./apply.ts";

/** Surface an apply outcome through a single notify — used for both edit kinds. */
function notifyApplyResult(r: ApplyResult, label: string, ctx: ExtensionContext): void {
  if (!r.ok) {
    const lines = r.error.failures.map((f) => `• ${f.path}: ${f.reason}`);
    ctx.ui.notify(`Some ${label}s failed:\n${lines.join("\n")}`, "error");
  } else {
    ctx.ui.notify(`Applied ${r.value.applied} ${label}${r.value.applied !== 1 ? "s" : ""}.`, "info");
  }
}

export async function applyEdits(
  edits: readonly ProposedEdit[],
  diffs: readonly ProposedDiffEdit[],
  ctx: ExtensionContext,
): Promise<void> {
  const hasEdits = edits.length > 0 || diffs.length > 0;
  if (!hasEdits) return;
  const cwd = ctx.cwd ?? process.cwd();

  if (edits.length > 0) {
    notifyApplyResult(await applyAnchorEdits(edits, cwd), "edit", ctx);
  }
  if (diffs.length > 0) {
    notifyApplyResult(await applyDiffEdits(diffs, cwd), "diff", ctx);
  }
}
