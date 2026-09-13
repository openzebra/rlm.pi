/** repl() tool TUI views — call card (code payload), collapsed/expanded result views.
 * Sub-call trees are not rendered here; the live tree widget owns agent visualization. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { CALL_PREVIEW_CHARS, previewText } from "../text/preview.ts";
import type { ReplDetails } from "./repl-details.ts";
import { highlightPython } from "../ui/python-highlight.ts";
import { cardHeader, cardStatsLine, renderCollapsedCard } from "./subcall-render.ts";

/** Chars of stdout/stderr shown in the expanded view. */
const EXPANDED_STDOUT_CHARS = 2_000;
const EXPANDED_STDERR_CHARS = 500;
/** Lines of Python source shown on the collapsed card before the "+N more lines" cut. */
const CODE_PREVIEW_LINES = 40;

// ── Call card ──

/**
 * The tool-call row. The collapsed card's payload IS the source — expanding swaps it for the
 * result view (context.expanded). While args still stream in (context.argsComplete false),
 * keep the one-line preview: half-arrived code reads as garbage.
 */
export function replCallView(
  args: { readonly code: string },
  theme: Theme,
  context?: { readonly expanded?: boolean; readonly argsComplete?: boolean },
): Text {
  const header = theme.fg("toolTitle", theme.bold("repl ")) + theme.fg("dim", previewText(args.code, CALL_PREVIEW_CHARS));
  if (context?.expanded === true || context?.argsComplete === false) {
    return new Text(header, 0, 0);
  }
  return new Text([header, "", renderReplCode(args.code, theme)].join("\n"), 0, 0);
}

// ── Collapsed view ──

function replStats(details: ReplDetails, theme: Theme): string {
  const elapsed = details.executionTimeMs > 0 ? `${details.executionTimeMs}ms` : undefined;
  return cardStatsLine(details.totals, theme, elapsed, details.backgroundPending);
}

export function renderReplCollapsed(details: ReplDetails, theme: Theme): Text {
  // Collapsed shows the CODE (replCallView); expanding reveals the result — say so.
  return renderCollapsedCard("REPL", details.status, replStats(details, theme), theme, "to show result");
}

/**
 * The collapsed card's payload — the cell's Python source, capped. Full source lives in the
 * session args; expanding swaps this block for the result view (see replCallView). Sliced
 * BEFORE highlighting so a triple-quoted string cut by the cap can only fall back to plain.
 */
export function renderReplCode(code: string, theme: Theme): string {
  const lines = code.split("\n");
  const shown = highlightPython(lines.slice(0, CODE_PREVIEW_LINES).join("\n"), theme);
  const rest = lines.length - CODE_PREVIEW_LINES;
  return rest > 0 ? `${shown}\n${theme.fg("muted", `… +${String(rest)} more lines`)}` : shown;
}

// ── Expanded view ──

export function renderReplExpanded(details: ReplDetails, theme: Theme): Container {
  const container = new Container();

  container.addChild(new Text(cardHeader("REPL", details.status, replStats(details, theme), theme), 0, 0));

  // Output
  if (details.output) {
    container.addChild(new Spacer(1));
    const out = details.output.length > EXPANDED_STDOUT_CHARS
      ? `${details.output.slice(0, EXPANDED_STDOUT_CHARS)}…`
      : details.output;
    container.addChild(new Text(out, 0, 0));
  }

  if (details.warnings && details.warnings.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", details.warnings.join("\n")), 0, 0));
  }

  // Stderr
  if (details.stderr) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", details.stderr.slice(0, EXPANDED_STDERR_CHARS)), 0, 0));
  }

  return container;
}
