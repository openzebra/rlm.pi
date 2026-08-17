/**
 * agent-modal — focused overlay showing one agent's live detail.
 *
 * Opened via ctx.ui.custom (pi's overlay API): pi routes keyboard input to the
 * component until done() fires. This class holds only view state (scroll
 * offset, subscription); every line is built by the pure modal-view builder.
 * Live updates: any registry change triggers a re-render, so the timeline
 * scrolls itself while the agent works.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { RunEntry, RunRegistry } from "../panel/run-registry.ts";
import { buildModalLines, MODAL_LAYOUT, type AgentViewData } from "./modal-view.ts";

const OVERLAY_OPTIONS = Object.freeze({ width: "70%" as const, maxHeight: "70%" as const, anchor: "center" as const });

export function openAgentModal(ctx: ExtensionContext, registry: RunRegistry, runId: string, nodeId: string): Promise<void> {
  return ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new AgentModalComponent(tui, theme, registry, runId, nodeId, done),
    { overlay: true, overlayOptions: OVERLAY_OPTIONS },
  );
}

class AgentModalComponent implements Component {
  private scroll = 0;
  private timelineLength = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly registry: RunRegistry,
    private readonly runId: string,
    private readonly nodeId: string,
    private readonly done: (result: void) => void,
  ) {
    this.unsubscribe = registry.onChange(() => this.tui.requestRender());
  }

  render(width: number): string[] {
    const data = this.collect();
    if (data === undefined) {
      return ["┌─ agent ─────────────────────┐", "│ run ended — data unavailable │", "│ esc close                    │", "└──────────────────────────────┘"];
    }
    this.timelineLength = data.timeline.length;
    return buildModalLines(data, this.scroll, width, this.theme);
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q") {
      this.dispose();
      this.done();
      return;
    }
    if (data === "\x1b[A") this.scroll = Math.max(0, this.scroll - 1);
    else if (data === "\x1b[B") this.scroll = Math.min(Math.max(0, this.timelineLength - MODAL_LAYOUT.timelineVisible), this.scroll + 1);
    this.tui.requestRender();
  }

  /** No cached render state — every render rebuilds from the live registry. */
  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  /** Snapshot the node (or the run root) as view data; undefined once the run unregisters. */
  private collect(): AgentViewData | undefined {
    const run = this.registry.find(this.runId);
    if (run === undefined) return undefined;
    return this.nodeId === this.runId ? rootView(run) : nodeView(run, this.nodeId);
  }
}

function rootView(run: RunEntry): AgentViewData {
  const status = run.rootStatus();
  return {
    label: run.label,
    icon: status === "aborted" ? "error" : status,
    phase: run.rootPhase(),
    depth: 0,
    tokens: run.totals().tokens,
    turns: run.turns(),
    timeline: run.timeline.forNode(run.runId),
  };
}

function nodeView(run: RunEntry, nodeId: string): AgentViewData | undefined {
  const node = run.subcalls().find((sc) => sc.id === nodeId);
  if (node === undefined) return undefined;
  return {
    label: node.label,
    icon: node.status,
    phase: node.phase,
    depth: node.depth,
    model: node.model,
    tokens: node.tokens,
    elapsedMs: (node.endedAt ?? Date.now()) - node.startedAt,
    detail: node.detail,
    args: node.args,
    timeline: run.timeline.forNode(nodeId),
  };
}
