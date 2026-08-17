/**
 * RunRegistry — session-scoped index of every live RLM surface (repl cells,
 * rlm tool runs, detached background work) for the tree widget and agent modal.
 *
 * Sources are registered as ACCESSORS (subcalls/totals) so any owner — a
 * per-call SubcallStore, BackgroundTasks' live view — fits without coupling.
 * The registry fans every emitter's change events out to widget/modal listeners
 * and builds immutable RunSnapshots on demand. register() returns an unregister
 * function; callers invoke it in finally so a failed run never leaks.
 */

import type { RlmEmitter } from "../../tool/rlm-events.ts";
import type { RlmRunStatus, RlmSubcall, SubcallPhase } from "../../tool/rlm-details.ts";
import type { RunSnapshot } from "../tree/tree-model.ts";
import { TimelineStore } from "../modal/timeline-store.ts";

export interface RunRegistration {
  readonly runId: string;
  /** Root row label — prompt or code preview. */
  readonly label: string;
  readonly emitter: RlmEmitter;
  readonly subcalls: () => readonly RlmSubcall[];
  readonly totals: () => { readonly costUsd: number; readonly tokens: number };
  /** Live root state; defaults: running, no phase, no turns. */
  readonly rootStatus?: () => RlmRunStatus;
  readonly rootPhase?: () => SubcallPhase | undefined;
  readonly turns?: () => { readonly current: number; readonly max: number };
  /** Persistent entries (background work) stay hidden until they hold subcalls. */
  readonly hideWhenEmpty?: boolean;
}

export interface RunEntry {
  readonly runId: string;
  readonly label: string;
  readonly timeline: TimelineStore;
  readonly subcalls: () => readonly RlmSubcall[];
  readonly totals: () => { readonly costUsd: number; readonly tokens: number };
  readonly rootStatus: () => RlmRunStatus;
  readonly rootPhase: () => SubcallPhase | undefined;
  readonly turns: () => { readonly current: number; readonly max: number };
  readonly hideWhenEmpty: boolean;
}

const DEFAULT_TURNS = Object.freeze({ current: 0, max: 0 });

export class RunRegistry {
  private readonly entries = new Map<string, RunEntry>();
  private readonly listeners: (() => void)[] = [];

  /** Register a live run. Returns an idempotent unregister — call it in finally. */
  register(run: RunRegistration): () => void {
    const entry: RunEntry = {
      runId: run.runId,
      label: run.label,
      timeline: new TimelineStore(run.emitter, run.runId),
      subcalls: run.subcalls,
      totals: run.totals,
      rootStatus: run.rootStatus ?? (() => "running"),
      rootPhase: run.rootPhase ?? (() => undefined),
      turns: run.turns ?? (() => DEFAULT_TURNS),
      hideWhenEmpty: run.hideWhenEmpty ?? false,
    };
    this.entries.set(run.runId, entry);
    const unsubs = [
      run.emitter.onSubcallCreated(() => this.notify()),
      run.emitter.onSubcallUpdated(() => this.notify()),
      run.emitter.onRootPhase(() => this.notify()),
      run.emitter.onStatus(() => this.notify()),
      run.emitter.onTurn(() => this.notify()),
    ];
    this.notify();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const unsub of unsubs) unsub();
      entry.timeline.dispose();
      this.entries.delete(run.runId);
      this.notify();
    };
  }

  /** Subscribe to any change in any registered run. Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  hasActive(): boolean {
    for (const entry of this.entries.values()) if (this.isVisible(entry)) return true;
    return false;
  }

  find(runId: string): RunEntry | undefined {
    return this.entries.get(runId);
  }

  /** Immutable view of every visible live run, registration order. */
  snapshots(): readonly RunSnapshot[] {
    const out: RunSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (!this.isVisible(entry)) continue;
      out.push({
        runId: entry.runId,
        rootLabel: entry.label,
        status: entry.rootStatus(),
        rootPhase: entry.rootPhase(),
        tokens: entry.totals().tokens,
        subcalls: entry.subcalls(),
      });
    }
    return Object.freeze(out);
  }

  private isVisible(entry: RunEntry): boolean {
    return !entry.hideWhenEmpty || entry.subcalls().length > 0;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
