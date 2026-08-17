/**
 * modal-view — pure line builder for the agent detail modal.
 *
 * Takes an immutable AgentViewData + scroll offset, returns bordered lines.
 * No TUI state, no side effects — the stateful wrapper lives in agent-modal.ts.
 * All assembly is segment arrays + join; ANSI-safe width math via pi-tui.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, spinnerFrame } from "../theme.ts";
import { modelShort } from "../tree/tree-rows.ts";
import type { SubcallPhase, SubcallStatus } from "../../tool/rlm-details.ts";
import type { TimelineEntry, TimelineIcon } from "./timeline-store.ts";

export const MODAL_LAYOUT = Object.freeze({
  /** Timeline rows visible at once (scroll window). */
  timelineVisible: 10,
  /** Prompt section line budget. */
  promptLines: 3,
  minWidth: 44,
} as const);

export interface AgentViewData {
  readonly label: string;
  readonly icon: SubcallStatus;
  readonly phase?: SubcallPhase;
  readonly depth: number;
  readonly model?: string;
  readonly tokens: number;
  /** Root rows only — omitted for subcall nodes. */
  readonly turns?: { readonly current: number; readonly max: number };
  readonly elapsedMs?: number;
  readonly detail?: string;
  readonly args?: string;
  readonly timeline: readonly TimelineEntry[];
}

const TIMELINE_GLYPHS: Readonly<Record<TimelineIcon, string>> = Object.freeze({
  spawn: "▸",
  phase: "◌",
  done: "✓",
  error: "✗",
  note: "·",
  turn: "↻",
});

function statusGlyph(icon: SubcallStatus, theme: Theme): string {
  switch (icon) {
    case "done": return theme.fg("success", "✓");
    case "error": return theme.fg("error", "✗");
    default: return theme.fg("warning", spinnerFrame());
  }
}

/** "┌─ title ───────┐" at exactly width columns. */
function topBorder(title: string, width: number, theme: Theme): string {
  const head = `┌─ ${title} `;
  const fill = Math.max(0, width - visibleWidth(head) - 1);
  return theme.fg("border", `${head}${"─".repeat(fill)}┐`);
}

/** "│ content … │" padded to width; content pre-truncated to the inner width. */
function row(content: string, width: number): string {
  const inner = width - 4;
  const cut = truncateToWidth(content, inner);
  const pad = Math.max(0, inner - visibleWidth(cut));
  return `│ ${cut}${" ".repeat(pad)} │`;
}

function timelineLine(entry: TimelineEntry, theme: Theme): string {
  const glyph = TIMELINE_GLYPHS[entry.icon];
  const colored = entry.icon === "error" ? theme.fg("error", glyph) : entry.icon === "done" ? theme.fg("success", glyph) : theme.fg("dim", glyph);
  return `${colored} ${entry.text}`;
}

export function buildModalLines(data: AgentViewData, scroll: number, width: number, theme: Theme): string[] {
  const w = Math.max(width, MODAL_LAYOUT.minWidth);
  const inner = w - 4;
  const lines: string[] = [];

  lines.push(topBorder(data.label, w, theme));

  // Status row: "⠸ running · thinking   depth 1   model gpt-5-mini"
  const statusParts = [`${statusGlyph(data.icon, theme)} ${data.icon}`];
  if (data.phase !== undefined && data.icon === "running") statusParts.push(`· ${data.phase}`);
  const stats: string[] = [`depth ${data.depth}`];
  if (data.model !== undefined) stats.push(`model ${modelShort(data.model)}`);
  lines.push(row(`${statusParts.join(" ")}   ${theme.fg("dim", stats.join("   "))}`, w));

  // Stats row: "tokens 4.3k   turn 3/25   elapsed 12.0s"
  const metricParts = [`tokens ${formatTokens(data.tokens)}`];
  if (data.turns !== undefined && data.turns.max > 0) metricParts.push(`turn ${data.turns.current}/${data.turns.max}`);
  if (data.elapsedMs !== undefined) metricParts.push(`elapsed ${formatDuration(data.elapsedMs)}`);
  lines.push(row(theme.fg("dim", metricParts.join("   ")), w));
  lines.push(row("", w));

  // Prompt section: detail first, args as fallback, capped to the line budget.
  const prompt = data.detail ?? data.args ?? "";
  lines.push(row(theme.fg("accent", "prompt"), w));
  if (prompt.length === 0) {
    lines.push(row(theme.fg("dim", "(none)"), w));
  } else {
    const words = prompt.split(" ");
    const wrapped: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line.length === 0 ? word : `${line} ${word}`;
      if (visibleWidth(next) > inner - 2) { wrapped.push(line); line = word; } else { line = next; }
      if (wrapped.length >= MODAL_LAYOUT.promptLines) break;
    }
    if (wrapped.length < MODAL_LAYOUT.promptLines && line.length > 0) wrapped.push(line);
    for (const part of wrapped.slice(0, MODAL_LAYOUT.promptLines)) lines.push(row(` ${part}`, w));
  }
  lines.push(row("", w));

  // Timeline window.
  const total = data.timeline.length;
  const maxScroll = Math.max(0, total - MODAL_LAYOUT.timelineVisible);
  const at = Math.min(scroll, maxScroll);
  const hint = total > MODAL_LAYOUT.timelineVisible ? `timeline ${at + 1}–${Math.min(total, at + MODAL_LAYOUT.timelineVisible)}/${total} · ↑↓ scroll` : "timeline";
  lines.push(row(theme.fg("accent", hint), w));
  const windowed = data.timeline.slice(at, at + MODAL_LAYOUT.timelineVisible);
  for (const entry of windowed) lines.push(row(` ${timelineLine(entry, theme)}`, w));
  // Stable height: pad unused timeline rows.
  for (let i = windowed.length; i < MODAL_LAYOUT.timelineVisible; i++) lines.push(row("", w));

  lines.push(row("", w));
  lines.push(row(theme.fg("dim", "esc close"), w));
  lines.push(theme.fg("border", `└${"─".repeat(Math.max(0, w - 2))}┘`));
  return lines;
}
