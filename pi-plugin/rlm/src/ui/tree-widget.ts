/**
 * Live agent/subagent tree shown above the editor during an RLM run.
 *
 * Renders the AgentTree: the root orchestrator and, nested beneath it, every sub-LLM call and
 * recursive child RLM, each with status, model, cost, tokens, and duration. Re-renders on tree
 * change and ticks a spinner while anything is running.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { AgentTree, type TreeNode } from "../state/agent-tree.ts";
import { formatCost, formatDuration, formatTokens, kindLabel, statusGlyph } from "./theme.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const COLOR: Record<string, "accent" | "success" | "error" | "muted"> = {
  root: "accent",
  rlm: "accent",
  batch: "muted",
  llm: "muted",
};

function nodeLine(node: TreeNode, theme: Theme, width: number, prefix: string): string {
  const statusColor = node.status === "error" ? "error" : node.status === "done" ? "success" : "accent";
  const glyph = theme.fg(statusColor, statusGlyph(node.status));
  const label = theme.fg(COLOR[node.kind] ?? "muted", kindLabel(node.kind));
  const model = node.model ? theme.fg("dim", ` ${node.model}`) : "";
  const detail = node.detail ? theme.fg("dim", `  ${node.detail}`) : "";
  const stats: string[] = [];
  if (node.costUsd > 0) stats.push(formatCost(node.costUsd));
  if (node.tokens > 0) stats.push(formatTokens(node.tokens));
  stats.push(formatDuration((node.endedAt ?? Date.now()) - node.startedAt));
  const statsStr = theme.fg("muted", `  ${stats.join(" · ")}`);
  return truncateToWidth(`${prefix}${glyph} ${label}${model}${detail}${statsStr}`, width);
}

function renderSubtree(tree: AgentTree, parentId: string | undefined, theme: Theme, width: number, indent: string, lines: string[]): void {
  const kids = tree.children(parentId);
  kids.forEach((node, i) => {
    const last = i === kids.length - 1;
    const branch = parentId === undefined ? "" : last ? "└─ " : "├─ ";
    lines.push(nodeLine(node, theme, width, indent + branch));
    const childIndent = parentId === undefined ? "" : indent + (last ? "   " : "│  ");
    renderSubtree(tree, node.id, theme, width, childIndent, lines);
  });
}

/** Pure render of the whole tree to lines (exported for tests). */
export function renderTree(tree: AgentTree, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  renderSubtree(tree, undefined, theme, width, "", lines);
  if (lines.length === 0) return [];
  const t = tree.totals();
  const header = theme.fg(
    "accent",
    theme.bold(`RLM · ${formatCost(t.costUsd)} · ${formatTokens(t.tokens)} tok · ${t.running} active`),
  );
  return [truncateToWidth(header, width), ...lines];
}

class TreeWidget implements Component {
  constructor(
    private readonly tree: AgentTree,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    return renderTree(this.tree, this.theme, width);
  }

  invalidate(): void {}
}

/** Build a setWidget factory that renders `tree` live and ticks while work is running. */
export function createTreeWidget(tree: AgentTree): WidgetFactory {
  return (tui, theme) => {
    const widget = new TreeWidget(tree, theme);
    const unsub = tree.onChange(() => tui.requestRender());
    // Keep the spinner animating while anything is running.
    const timer = setInterval(() => {
      if (tree.totals().running > 0) tui.requestRender();
    }, 120);
    return Object.assign(widget, {
      dispose() {
        unsub();
        clearInterval(timer);
      },
    });
  };
}
