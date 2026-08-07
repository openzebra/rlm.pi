/**
 * Session-scoped home for detached `spawn()` work in native repl() mode.
 *
 * A spawned sub-call may settle after the repl() call that started it has returned, when
 * that turn's RlmEmitter has been shut down and its LimitGuard discarded. Both live here for
 * the whole session instead. The turn that awaits a task — or simply the next turn to run —
 * adopts its settled subtree into its own ReplDetails, so background spend is reported even
 * when the model never collects the result.
 *
 * The headless engine needs none of this: its emitter and guard already outlive every
 * sub-call it services (see core/engine.ts).
 */

import { RlmEmitter } from "./rlm-events.ts";
import { SubcallStore, type SubcallTotals } from "./subcall-store.ts";
import type { RlmSubcall } from "./rlm-details.ts";
import { LimitGuard, type Limits } from "../core/limits.ts";
import type { Invocation } from "../bridge/subcall-handlers.ts";
import { trace, traceEnabled } from "../util/trace.ts";

/** What a drain hands to the turn that is reporting it. */
export interface BackgroundDrain {
  readonly subcalls: readonly RlmSubcall[];
  readonly totals: SubcallTotals;
}

export class BackgroundTasks {
  /** "bg" prefix so these IDs can never collide with a turn emitter's `s1, s2, …`. */
  private readonly _emitter = new RlmEmitter("bg");
  private readonly store = new SubcallStore(this._emitter);
  private readonly limits: LimitGuard;
  private active = 0;

  constructor(limits: Limits) {
    this.limits = new LimitGuard(limits);
  }

  /** Read-only access for the progressive tracer (scope "background"). */
  get emitter(): RlmEmitter {
    return this._emitter;
  }

  /** The Invocation detached sub-calls resolve to. Stable for the session. */
  get invocation(): Invocation {
    return {
      emitter: this._emitter,
      parentId: undefined,
      depth: 0,
      limits: this.limits,
    };
  }

  /** Detached sub-calls still in flight. The single pending counter for the session. */
  get pending(): number {
    return this.active;
  }

  /** Live snapshot of detached sub-calls, settled or not — progressive rendering only. */
  liveSubcalls(): readonly RlmSubcall[] {
    return this.store.getSubcalls();
  }

  /** Live totals for that same snapshot. Accounting still flows through `drain()`. */
  liveTotals(): SubcallTotals {
    return this.store.getTotals();
  }

  /** Count `run` as in-flight detached work for its duration. */
  async track<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    const startedAt = Date.now();
    if (traceEnabled) trace("bg.start", { pending: this.active });
    try {
      return await run();
    } finally {
      this.active -= 1;
      if (traceEnabled) trace("bg.settle", { pending: this.active, durationMs: Date.now() - startedAt });
    }
  }

  /**
   * Hand over every fully-settled subtree and forget it.
   *
   * Called at the end of every repl() call, not only when a task was awaited, so a spawn
   * the model never collects still reaches the user's cost totals.
   */
  drain(): BackgroundDrain {
    return this.store.takeSettledSubtrees();
  }

  dispose(): void {
    this.store.dispose();
    this._emitter.shutdown();
  }
}
