/**
 * Modal TUI overlay that renders a unified diff and lets the user
 * Accept (a) or Reject (r) it before it is applied to disk.
 *
 * Rendering rules:
 *   +lines  → theme.fg("success", line)
 *   -lines  → theme.fg("error",   line)
 *   @@lines → theme.fg("muted",   line)
 *   rest    → theme.fg("dim",     line)
 *
 * Scroll: ↑/↓ or j/k. No business logic here — pure rendering.
 */

import * as Diff from "diff";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";

export type PopupResult = "accept" | "reject";

// ── Diff generation for ProposedEdit (oldText/newText) ──────────────────────

function anchorToDiff(edit: ProposedEdit): string {
  try {
    return Diff.createPatch(edit.path, edit.oldText, edit.newText, "", "");
  } catch {
    return `(failed to render diff for ${edit.path})`;
  }
}

// ── Build a single unified string to display ────────────────────────────────

export function buildPreviewText(
  edits: readonly ProposedEdit[],
  diffs: readonly ProposedDiffEdit[],
): string {
  // Total size is known up front — spread + join, no push-in-loop.
  return [...edits.map(anchorToDiff), ...diffs.map((d) => d.diff)].join("\n");
}

// ── Line colouring (pure, no side-effects) ──────────────────────────────────

function colorLine(line: string, theme: Theme): string {
  if (line.startsWith("+")) return theme.fg("success", line);
  if (line.startsWith("-")) return theme.fg("error", line);
  if (line.startsWith("@@")) return theme.fg("muted", line);
  return theme.fg("dim", line);
}

const VISIBLE_ROWS = 20;

// ── Public API ───────────────────────────────────────────────────────────────

export async function showPatchPopup(
  edits: readonly ProposedEdit[],
  diffs: readonly ProposedDiffEdit[],
  ctx: ExtensionContext,
): Promise<PopupResult> {
  // Non-interactive contexts cannot show a modal — auto-accept.
  if (ctx.mode !== "tui") return "accept";

  const previewText = buildPreviewText(edits, diffs);
  const editCount = edits.length + diffs.length;

  // Params with explicit, verified types; `unknown` for the two intentionally
  // unused infra args (TUI/KeybindingsManager) is safe under contravariance.
  return ctx.ui.custom<PopupResult>(
    (_tui: unknown, theme: Theme, _kb: unknown, done: (result: PopupResult) => void) => {
      const rawLines = previewText.split("\n");

      // Pre-allocate — size known.
      const coloredLines = new Array<string>(rawLines.length);
      for (let i = 0; i < rawLines.length; i++) {
        coloredLines[i] = colorLine(rawLines[i] ?? "", theme);
      }

      // Mutable scroll state — render reads from this on every call.
      const state: { scrollTop: number } = { scrollTop: 0 };

      const container = new Container();
      container.addChild(new Text(
        theme.fg("toolTitle", theme.bold(
          `RLM proposed ${editCount} edit${editCount !== 1 ? "s" : ""} — [a]ccept / [r]eject`,
        )),
        1, 0,
      ));
      container.addChild(new Text(theme.fg("muted", "─".repeat(60)), 0, 0));

      // Custom Component whose render reads mutable scroll state — mirrors the
      // `filterLine: Component` pattern in model-picker.ts.
      const diffView: Component = {
        render: (_w: number) => {
          const slice = coloredLines.slice(state.scrollTop, state.scrollTop + VISIBLE_ROWS);
          const remaining = coloredLines.length - state.scrollTop - VISIBLE_ROWS;
          return remaining > 0
            ? [...slice, theme.fg("muted", `↓ ${remaining} more lines (j/↓ scroll)`)]
            : slice;
        },
        invalidate: () => {},
      };
      container.addChild(diffView);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === "a" || data === "y") { done("accept"); return; }
          if (data === "r" || data === "n" || data === "\x1b") { done("reject"); return; }
          if (data === "\x1b[A" || data === "k") {
            state.scrollTop = Math.max(0, state.scrollTop - 1);
            container.invalidate();
            return;
          }
          if (data === "\x1b[B" || data === "j") {
            state.scrollTop = Math.min(
              Math.max(0, coloredLines.length - VISIBLE_ROWS),
              state.scrollTop + 1,
            );
            container.invalidate();
            return;
          }
        },
      };
    },
  );
}
