/**
 * Shared sub-call tree rendering for RLM tools (rlm + repl).
 *
 * Both tools accumulate RlmSubcall[] arrays with parentId links. This module
 * provides the collapsed ASCII tree and expanded Container-based tree rendering
 * used by their renderResult() implementations.
 */

import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { keyText } from "@earendil-works/pi-coding-agent";
import type { RlmSubcall, SubcallStatus } from "./rlm-details.ts";
import { formatCost, formatDuration, formatTokens, spinnerFrame } from "../ui/theme.ts";
import { previewText } from "../text/preview.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Preview budgets for the expanded tree (args are terse, results get more room). */
const ARGS_PREVIEW_CHARS = 80;
const RESULT_PREVIEW_CHARS = 120;

// ── Glyphs ──

export function subcallStatusGlyph(sc: Pick<RlmSubcall, "status">, theme: Theme): string {
  if (sc.status === "running") return theme.fg("warning", "⏳");
  if (sc.status === "error") return theme.fg("error", "✗");
  return theme.fg("success", "✓");
}

export function headlineStatusGlyph(status: SubcallStatus | "aborted" | "done", theme: Theme): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "error": return theme.fg("error", "✗");
    case "aborted": return theme.fg("warning", "◐");
    default: return theme.fg("warning", spinnerFrame());
  }
}

// ── Stats formatting ──

export function subcallStatsLine(sc: Pick<RlmSubcall, "costUsd" | "tokens" | "endedAt" | "startedAt">): string {
  const parts: string[] = [];
  if (sc.costUsd > 0) parts.push(formatCost(sc.costUsd));
  if (sc.tokens > 0) parts.push(`${formatTokens(sc.tokens)} tok`);
  // Explicit undefined checks: a 0 timestamp is falsy but legitimate (fixtures, epoch clocks).
  if (sc.endedAt !== undefined && sc.startedAt !== undefined) parts.push(formatDuration(sc.endedAt - sc.startedAt));
  return parts.join(" · ");
}

// ── Shared card scaffolding (rlm + repl render the same shape) ──

/** The `$0.0123 · 4.2k tok · 812ms` run of a card header. Omits any zero component. */
export function cardStatsLine(
  totals: { readonly costUsd: number; readonly tokens: number },
  theme: Theme,
  extra?: string,
): string {
  const parts: string[] = [formatCost(totals.costUsd)];
  if (totals.tokens > 0) parts.push(`${formatTokens(totals.tokens)} tok`);
  if (extra) parts.push(extra);
  return theme.fg("dim", parts.join(" · "));
}

/** `<glyph> <TITLE> <stats>` — the first line of both tools' collapsed and expanded views. */
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

/** The collapsed card: header, the sub-call tree, and the expand hint. */
export function renderCollapsedCard(
  title: string,
  status: SubcallStatus | "aborted" | "done",
  stats: string,
  subcalls: readonly RlmSubcall[],
  theme: Theme,
): Text {
  const body = subcalls.length > 0 ? `\n${renderCollapsedSubcallTree(subcalls, theme)}` : "";
  const hint = status === "running" ? "" : `\n${expandHint(theme)}`;
  return new Text(`${cardHeader(title, status, stats, theme)}${body}${hint}`, 0, 0);
}

// ── Tree building ──

function buildParentMap(subcalls: readonly RlmSubcall[]): Map<string | undefined, RlmSubcall[]> {
  const map = new Map<string | undefined, RlmSubcall[]>();
  for (const sc of subcalls) {
    const list = map.get(sc.parentId) ?? [];
    list.push(sc);
    map.set(sc.parentId, list);
  }
  return map;
}

// ── Collapsed tree (ASCII) ──

export function renderCollapsedSubcallTree(
  subcalls: readonly RlmSubcall[],
  theme: Theme,
): string {
  if (subcalls.length === 0) return "";

  const byParent = buildParentMap(subcalls);

  function walk(parentId: string | undefined, prefix: string): string[] {
    const lines: string[] = [];
    const direct = byParent.get(parentId) ?? [];
    for (let i = 0; i < direct.length; i++) {
      const sc = direct[i];
      if (!sc) continue;
      const isLast = i === direct.length - 1;
      const branch = isLast ? "└─" : "├─";
      const gGlyph = subcallStatusGlyph(sc, theme);
      const gStats = subcallStatsLine(sc);
      lines.push(`${prefix}${branch} ${sc.label}  ${gGlyph}  ${gStats}`);
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      lines.push(...walk(sc.id, childPrefix));
    }
    return lines;
  }

  return walk(undefined, "  ").join("\n");
}

// ── Expanded tree (Container) ──

export function renderExpandedSubcallTree(
  subcalls: readonly RlmSubcall[],
  theme: Theme,
): Component {
  const container = new Container();
  if (subcalls.length === 0) return container;

  const byParent = buildParentMap(subcalls);

  function renderNode(sc: RlmSubcall, indent: number): void {
    const pad = "  ".repeat(indent);
    const sGlyph = subcallStatusGlyph(sc, theme);
    const sKind = theme.fg("muted", sc.label);
    const sModel = sc.model ? theme.fg("dim", ` ${sc.model}`) : "";
    const sStats = sc.endedAt ? `  ${theme.fg("dim", subcallStatsLine(sc))}` : "";
    let line = `${pad}${sGlyph} ${sKind}${sModel}${sStats}`;

    if (sc.args) {
      line += `\n${pad}  ${theme.fg("dim", previewText(sc.args, ARGS_PREVIEW_CHARS))}`;
    }
    if (sc.status === "error" && sc.detail) {
      line += `\n${pad}  ${theme.fg("error", `✗ ${sc.detail}`)}`;
    } else if (sc.resultPreview) {
      line += `\n${pad}  ${theme.fg("toolOutput", previewText(sc.resultPreview, RESULT_PREVIEW_CHARS))}`;
    }

    container.addChild(new Text(line, 0, 0));

    for (const child of (byParent.get(sc.id) ?? [])) {
      renderNode(child, indent + 1);
    }
  }

  for (const sc of (byParent.get(undefined) ?? [])) {
    renderNode(sc, 1);
  }

  return container;
}
