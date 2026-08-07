/**
 * SubcallStore — shared subcall state accumulator for RLM lifecycle events.
 *
 * Subscribes to RlmEmitter subcall:created / subcall:updated events and
 * accumulates RlmSubcall[] state with O(1) running totals. Used by both
 * RlmEventAggregator (rlm tool) and repl() tool to eliminate duplicated
 * subcall accumulation logic.
 */
import type { RlmEmitter, SubcallCreatedEvent, SubcallUpdatedEvent } from "./rlm-events.ts";
import type { RlmSubcall, SubcallStatus } from "./rlm-details.ts";
import { EmitterListener } from "./emitter-listener.ts";

type MutableSubcall = {
  -readonly [Key in keyof RlmSubcall]: RlmSubcall[Key];
};

/** Accumulated cost/tokens, shared by getTotals() and takeSettledSubtrees(). */
export interface SubcallTotals {
  readonly costUsd: number;
  readonly tokens: number;
}

export class SubcallStore extends EmitterListener {
  private readonly subcalls = new Map<string, MutableSubcall>();

  private totalCostUsd = 0;
  private totalTokens = 0;

  constructor(emitter: RlmEmitter, private readonly onChange?: () => void) {
    super();
    this.trackAll([
      emitter.onSubcallCreated((e) => { this.handleSubcallCreated(e); this.onChange?.(); }),
      emitter.onSubcallUpdated((e) => { this.handleSubcallUpdated(e); this.onChange?.(); }),
    ]);
  }

  // ── Event handlers ──

  private handleSubcallCreated(event: SubcallCreatedEvent): void {
    this.subcalls.set(event.id, {
      id: event.id,
      parentId: event.parentId,
      depth: event.depth,
      kind: event.kind,
      label: event.label,
      model: event.model,
      status: "running",
      detail: event.detail,
      args: event.args,
      startedAt: Date.now(),
      costUsd: 0,
      tokens: 0,
    });
  }

  private handleSubcallUpdated(event: SubcallUpdatedEvent): void {
    const sc = this.subcalls.get(event.id);
    if (!sc) return;

    if (event.status !== undefined) {
      sc.status = event.status;
      if (event.status !== "running") sc.endedAt = Date.now();
    }
    if (event.detail !== undefined) sc.detail = event.detail;
    if (event.args !== undefined) sc.args = event.args;
    if (event.resultPreview !== undefined) sc.resultPreview = event.resultPreview;
    if (event.costUsd !== undefined) {
      sc.costUsd += event.costUsd;
      this.totalCostUsd += event.costUsd;
    }
    if (event.tokens !== undefined) {
      sc.tokens += event.tokens;
      this.totalTokens += event.tokens;
    }
    if (event.failedCount !== undefined) sc.failedCount = event.failedCount;
    if (event.totalCount !== undefined) sc.totalCount = event.totalCount;
  }

  // ── Read ──

  /** Snapshot subcall array. Allocates a new array from Map values. */
  getSubcalls(): RlmSubcall[] {
    return Array.from(this.subcalls.values(), (subcall) => Object.freeze({ ...subcall }));
  }

  /** Snapshot running totals. O(1). */
  getTotals(): { readonly costUsd: number; readonly tokens: number } {
    return { costUsd: this.totalCostUsd, tokens: this.totalTokens };
  }

  /**
   * Remove and return every fully-settled root subtree, with its cost/tokens subtracted
   * from the running totals so the caller can add them without double-counting.
   *
   * A root whose subtree still has a running node stays put. That matters because
   * `renderCollapsedSubcallTree` walks down from `parentId === undefined`: a subcall handed
   * over without its parent has no path from a root and is silently dropped from the tree.
   * Handing over whole subtrees is what keeps adopted nodes renderable.
   */
  takeSettledSubtrees(): { readonly subcalls: readonly RlmSubcall[]; readonly totals: SubcallTotals } {
    const children = new Map<string | undefined, MutableSubcall[]>();
    for (const sc of this.subcalls.values()) {
      const siblings = children.get(sc.parentId);
      if (siblings === undefined) children.set(sc.parentId, [sc]);
      else siblings.push(sc);
    }

    // Collect a root's subtree, or undefined when any node in it is still running.
    const settledSubtree = (root: MutableSubcall): MutableSubcall[] | undefined => {
      const collected: MutableSubcall[] = [];
      const stack: MutableSubcall[] = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        if (node.status === "running") return undefined;
        collected.push(node);
        const kids = children.get(node.id);
        if (kids !== undefined) stack.push(...kids);
      }
      return collected;
    };

    const taken: RlmSubcall[] = [];
    let costUsd = 0;
    let tokens = 0;
    for (const root of children.get(undefined) ?? []) {
      const subtree = settledSubtree(root);
      if (subtree === undefined) continue;
      for (const node of subtree) {
        costUsd += node.costUsd;
        tokens += node.tokens;
        taken.push(Object.freeze({ ...node, status: node.status as SubcallStatus }));
        this.subcalls.delete(node.id);
      }
    }
    this.totalCostUsd -= costUsd;
    this.totalTokens -= tokens;
    return { subcalls: taken, totals: { costUsd, tokens } };
  }

  // ── Root usage (delegated from RlmEventAggregator) ──

  /** Accumulate root-level usage into shared totals. Called by aggregator. */
  addRootUsage(costUsd: number, tokens: number): void {
    this.totalCostUsd += costUsd;
    this.totalTokens += tokens;
  }
}
