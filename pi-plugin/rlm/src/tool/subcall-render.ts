/**
 * Card scaffolding for RLM tool results (rlm + repl).
 *
 * The chat transcript renders ONE line per call — status glyph, title, stats —
 * plus the expand hint. Agent trees are NOT rendered here: the live tree
 * widget and agent modal (ui/tree/, ui/modal/) own all agent visualization.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyText } from "@earendil-works/pi-coding-agent";
import type { SubcallStatus } from "./rlm-details.ts";
import { formatTokens, spinnerFrame } from "../ui/theme.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Glyphs ──

export function headlineStatusGlyph(status: SubcallStatus | "aborted" | "done", theme: Theme): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "error": return theme.fg("error", "✗");
    case "aborted": return theme.fg("warning", "◐");
    default: return theme.fg("warning", spinnerFrame());
  }
}

// ── Stats formatting ──

/** The `4.2k tok · 812ms` run of a card header. Omits any zero component. */
export function cardStatsLine(
  totals: { readonly tokens: number },
  theme: Theme,
  extra?: string,
  backgroundPending?: number,
): string {
  const parts: string[] = [];
  if (totals.tokens > 0) parts.push(`${formatTokens(totals.tokens)} tok`);
  if (extra) parts.push(extra);
  const line = theme.fg("dim", parts.join(" · "));
  // The one thing no single line can show: spawned work that may outlive this block.
  return backgroundPending !== undefined && backgroundPending > 0
    ? `${line} ${theme.fg("warning", `↯${backgroundPending} bg`)}`
    : line;
}

/** `<glyph> <TITLE> <stats>` — the card's single header line. */
export function cardHeader(
  title: string,
  status: SubcallStatus | "aborted" | "done",
  stats: string,
  theme: Theme,
): string {
  return `${headlineStatusGlyph(status, theme)} ${theme.fg("toolTitle", theme.bold(title))} ${stats}`;
}

/**
 * The expand hint, using the user's actual binding rather than a hardcoded "Ctrl+O".
 *
 * Deliberately `keyText` + the injected theme rather than pi's `keyHint`: `keyHint` colours via
 * pi's module-global theme, which throws when that global is uninitialized — the same jiti
 * hazard `ui/theme-adapter.ts` exists to avoid. `keyText` only reads the keybinding registry.
 */
function expandHint(theme: Theme): string {
  // Empty outside a live pi session (the app installs the real binding registry at startup) —
  // the phrase stays the same, only the key prefix drops out.
  const key = keyText("app.tools.expand");
  return theme.fg("muted", key ? `${key} to expand` : "to expand");
}

/** The collapsed card: header line, then the expand hint once settled. */
export function renderCollapsedCard(
  title: string,
  status: SubcallStatus | "aborted" | "done",
  stats: string,
  theme: Theme,
): Text {
  const hint = status === "running" ? "" : `\n${expandHint(theme)}`;
  return new Text(`${cardHeader(title, status, stats, theme)}${hint}`, 0, 0);
}
