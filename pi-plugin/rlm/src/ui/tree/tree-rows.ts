/**
 * tree-rows — pure formatting of TreeRow[] into terminal lines.
 *
 * String building is segment-array + join (no += chains). Width math uses
 * pi-tui's visibleWidth/truncateToWidth so ANSI colors never break alignment.
 * Glyphs come from ui/theme.ts (single spinner/format source — no duplicates).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, spinnerFrame } from "../theme.ts";
import type { NodeRow, OverflowRow, TreeRow } from "./tree-model.ts";

const GLYPHS = Object.freeze({ done: "✓", error: "✗", expanded: "▾", collapsed: "▸", leaf: " " } as const);
const MODEL_MAX = 14;

/** "openai/gpt-5-mini" → "gpt-5-mini", hard-capped so rows stay on one line. */
export function modelShort(model: string): string {
  const last = model.slice(model.lastIndexOf("/") + 1);
  return last.length > MODEL_MAX ? `${last.slice(0, MODEL_MAX - 1)}…` : last;
}

function iconGlyph(row: NodeRow, theme: Theme): string {
  switch (row.icon) {
    case "done": return theme.fg("success", GLYPHS.done);
    case "error": return theme.fg("error", GLYPHS.error);
    default: return theme.fg("warning", spinnerFrame());
  }
}

/** Right-hand stats: "4.3k tok · gpt-5-mini" (model only when present). */
function statsText(row: NodeRow): string {
  const parts = [`${formatTokens(row.tokens)} tok`];
  if (row.model !== undefined) parts.push(modelShort(row.model));
  return parts.join(" · ");
}

function formatNode(row: NodeRow, selected: boolean, width: number, theme: Theme): string {
  const chevron = row.expandable ? (row.expanded ? GLYPHS.expanded : GLYPHS.collapsed) : GLYPHS.leaf;
  const cursor = selected ? theme.fg("accent", "❯") : " ";
  const left = `${cursor} ${row.prefix}${chevron} ${iconGlyph(row, theme)} ${row.label}`;
  const right = theme.fg("dim", statsText(row));
  const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
  const line = gap > 0 ? `${left}${" ".repeat(gap)}${right}` : `${truncateToWidth(left, width - 1)} `;
  return selected ? theme.fg("accent", line) : line;
}

function formatOverflow(row: OverflowRow, width: number, theme: Theme): string {
  return truncateToWidth(theme.fg("dim", `  ${row.prefix}… ×${row.count} more`), width);
}

export function formatRow(row: TreeRow, selected: boolean, width: number, theme: Theme): string {
  return row.type === "overflow" ? formatOverflow(row, width, theme) : formatNode(row, selected, width, theme);
}

/** Pre-sized output — row count is known, no push-in-loop. */
export function formatRows(rows: readonly TreeRow[], selectedId: string | undefined, width: number, theme: Theme): string[] {
  const lines = new Array<string>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    lines[i] = formatRow(row, row !== undefined && row.type === "node" && row.id === selectedId, width, theme);
  }
  return lines;
}
