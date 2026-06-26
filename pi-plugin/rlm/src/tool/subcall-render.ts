/**
 * Shared sub-call tree rendering for RLM tools (rlm + repl).
 *
 * Both tools accumulate RlmSubcall[] arrays with parentId links. This module
 * provides the collapsed ASCII tree and expanded Container-based tree rendering
 * used by their renderResult() implementations.
 */

import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { RlmSubcall, SubcallStatus } from "./rlm-details.ts";
import { formatCost, formatDuration, formatTokens, spinnerFrame } from "../ui/theme.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Glyphs ──

export function subcallRunningGlyph(theme: Theme): string {
  return theme.fg("warning", spinnerFrame());
}

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
  if (sc.endedAt && sc.startedAt) parts.push(formatDuration(sc.endedAt - sc.startedAt));
  return parts.join(" · ");
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
      const ap = sc.args.length > 80 ? `${sc.args.slice(0, 80)}...` : sc.args;
      line += `\n${pad}  ${theme.fg("dim", ap)}`;
    }
    if (sc.status === "error" && sc.detail) {
      line += `\n${pad}  ${theme.fg("error", `✗ ${sc.detail}`)}`;
    } else if (sc.resultPreview) {
      const rp = sc.resultPreview.length > 120 ? `${sc.resultPreview.slice(0, 120)}...` : sc.resultPreview;
      line += `\n${pad}  ${theme.fg("toolOutput", rp)}`;
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
