/**
 * TreeWidget — the persistent live agent tree below the editor.
 *
 * Implements pi's Component contract (render / handleInput via panel-mediated
 * keys / invalidate / dispose). All heavy lifting is delegated: buildRows and
 * formatRows are pure; this class only holds view state — collapsed nodes,
 * cursor, focus mode, dirty flag — and owns the spinner timer, which runs
 * ONLY while some node is running and is always cleared in dispose().
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunRegistry } from "../panel/run-registry.ts";
import { buildRows, type NodeRow, type TreeRow } from "./tree-model.ts";
import { formatRows } from "./tree-rows.ts";

const SPINNER_INTERVAL_MS = 100;
/** Right-aligned stats never drift past this many columns, however wide the terminal. */
const ROW_WIDTH_CAP = 110;

const KEYS = Object.freeze({
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
} as const);

/** What the panel should do after a keypress. Discriminated — never a boolean soup. */
export type KeyAction =
  | { readonly type: "swallowed" }
  | { readonly type: "unfocus" }
  | { readonly type: "open"; readonly runId: string; readonly nodeId: string };

export class TreeWidget implements Component {
  private readonly collapsed = new Set<string>();
  private rows: readonly TreeRow[] = [];
  private selectedId: string | undefined;
  private focused = false;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly registry: RunRegistry,
  ) {
    this.unsubscribe = registry.onChange(() => {
      this.dirty = true;
      this.tui.requestRender();
    });
  }

  get isFocused(): boolean {
    return this.focused;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (focused) {
      this.rebuild();
      this.selectedId = this.selectedId ?? this.nodeRows()[0]?.id;
    }
    this.tui.requestRender();
  }

  /** Panel-mediated key handling (widgets don't own terminal focus). */
  handleKey(data: string): KeyAction {
    if (data === KEYS.escape) {
      this.setFocused(false);
      return { type: "unfocus" };
    }
    if (data === KEYS.up) this.move(-1);
    else if (data === KEYS.down) this.move(1);
    else if (data === KEYS.left) this.collapseSelected();
    else if (data === KEYS.right) this.expandSelected();
    else if (data === KEYS.enter) {
      const row = this.selectedRow();
      if (row !== undefined) return { type: "open", runId: row.runId, nodeId: row.id };
    }
    this.tui.requestRender();
    return { type: "swallowed" };
  }

  render(width: number): string[] {
    if (this.dirty) this.rebuild();
    if (this.rows.length === 0) return [];
    // pi renders belowEditor widgets flush under the editor's own bottom rule —
    // no full-width header from us, it would stack a third rule and eat space.
    // Unfocused: rows only. Focused: short accent tag + key hint.
    const body = formatRows(this.rows, this.focused ? this.selectedId : undefined, Math.min(width, ROW_WIDTH_CAP), this.theme);
    if (!this.focused) return body;
    return [
      this.theme.fg("accent", "─ RLM ─"),
      ...body,
      this.theme.fg("dim", "↑↓ move · ←→ collapse · enter details · esc unfocus"),
    ];
  }

  invalidate(): void {
    this.dirty = true;
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // ── Internal ──

  private rebuild(): void {
    const all: TreeRow[] = [];
    for (const run of this.registry.snapshots()) {
      for (const row of buildRows(run, this.collapsed)) all.push(row);
    }
    this.rows = Object.freeze(all);
    this.dirty = false;
    // A node that disappeared (run unregistered) must not stay selected.
    if (this.selectedId !== undefined && !this.nodeRows().some((r) => r.id === this.selectedId)) {
      this.selectedId = this.nodeRows()[0]?.id;
    }
    this.syncTimer();
  }

  /** Spinner ticks only while something is running; idle widgets cost zero. */
  private syncTimer(): void {
    const anyRunning = this.rows.some((r) => r.type === "node" && r.icon === "running");
    if (anyRunning && this.timer === undefined) {
      const timer = setInterval(() => this.tui.requestRender(), SPINNER_INTERVAL_MS);
      timer.unref();
      this.timer = timer;
    } else if (!anyRunning && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private nodeRows(): NodeRow[] {
    const out: NodeRow[] = [];
    for (const row of this.rows) if (row.type === "node") out.push(row);
    return out;
  }

  private selectedRow(): NodeRow | undefined {
    return this.nodeRows().find((r) => r.id === this.selectedId);
  }

  private move(delta: number): void {
    const nodes = this.nodeRows();
    if (nodes.length === 0) return;
    const at = nodes.findIndex((r) => r.id === this.selectedId);
    const next = nodes[Math.min(nodes.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
    if (next !== undefined) this.selectedId = next.id;
  }

  private collapseSelected(): void {
    const row = this.selectedRow();
    if (row !== undefined && row.expandable && row.expanded) {
      this.collapsed.add(row.id);
      this.dirty = true;
    }
  }

  private expandSelected(): void {
    const row = this.selectedRow();
    if (row !== undefined && row.expandable && !row.expanded) {
      this.collapsed.delete(row.id);
      this.dirty = true;
    }
  }
}
