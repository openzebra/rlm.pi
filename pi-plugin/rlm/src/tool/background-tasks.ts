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

/** What a drain hands to the turn that is reporting it. */
export interface BackgroundDrain {
  readonly subcalls: readonly RlmSubcall[];
  readonly totals: SubcallTotals;
}

export class BackgroundTasks {
  /** "bg" prefix so these IDs can never collide with a turn emitter's `s1, s2, …`. */
  private readonly emitter = new RlmEmitter("bg");
  private readonly store = new SubcallStore(this.emitter);
  private readonly limits: LimitGuard;
  private active = 0;

  constructor(limits: Limits) {
    this.limits = new LimitGuard(limits);
  }

  /** The Invocation detached sub-calls resolve to. Stable for the session. */
  get invocation(): Invocation {
    return {
      emitter: this.emitter,
      parentId: undefined,
      depth: 0,
      limits: this.limits,
    };
  }

  /** Detached sub-calls still in flight. The single pending counter for the session. */
  get pending(): number {
    return this.active;
  }

  /** Count `run` as in-flight detached work for its duration. */
  async track<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await run();
    } finally {
      this.active -= 1;
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
    this.emitter.shutdown();
  }
}
