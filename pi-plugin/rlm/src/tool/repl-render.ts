/** repl() tool TUI views — the single-line card and the expanded output view.
 * Sub-call trees are not rendered here; the live tree widget owns agent visualization. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ReplDetails } from "./repl-details.ts";
import { cardHeader, cardStatsLine, renderCollapsedCard } from "./subcall-render.ts";

/** Chars of stdout/stderr shown in the expanded view. */
const EXPANDED_STDOUT_CHARS = 2_000;
const EXPANDED_STDERR_CHARS = 500;

// ── Collapsed view ──

export function replStats(details: ReplDetails, theme: Theme): string {
  const elapsed = details.executionTimeMs > 0 ? `${details.executionTimeMs}ms` : undefined;
  return cardStatsLine(details.totals, theme, elapsed, details.backgroundPending);
}

export function renderReplCollapsed(details: ReplDetails, theme: Theme): Text {
  return renderCollapsedCard("REPL", details.status, replStats(details, theme), theme);
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
