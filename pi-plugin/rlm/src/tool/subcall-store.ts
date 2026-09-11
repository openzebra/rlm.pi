/**
 * SubcallStore — shared subcall state accumulator for RLM lifecycle events.
 *
 * Subscribes to RlmEmitter subcall:created / subcall:updated events and
 * accumulates RlmSubcall[] state with O(1) running totals. Used by both
 * RlmEventAggregator (rlm tool) and repl() tool to eliminate duplicated
 * subcall accumulation logic.
 */
import type { RlmEmitter, SubcallCreatedEvent, SubcallUpdatedEvent } from "./rlm-events.ts";
import type { RlmSubcall } from "./rlm-details.ts";
import { EmitterListener } from "./emitter-listener.ts";

type MutableSubcall = {
  -readonly [Key in keyof RlmSubcall]: RlmSubcall[Key];
};

/** Accumulated tokens, shared by getTotals() and takeSettledSubtrees(). */
export interface SubcallTotals {
  readonly tokens: number;
  /** In/out split (input / output) — mirrors tokens, shown separately in the tree. */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export class SubcallStore extends EmitterListener {
  private readonly subcalls = new Map<string, MutableSubcall>();

  private totalTokens = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;
  private rootTokens = 0;
  private rootTokensIn = 0;
  private rootTokensOut = 0;

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
      tokens: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
  }

  private handleSubcallUpdated(event: SubcallUpdatedEvent): void {
    const sc = this.subcalls.get(event.id);
    if (!sc) return;

    if (event.status !== undefined) {
      sc.status = event.status;
      if (event.status !== "running") sc.endedAt = Date.now();
    }
    if (event.phase !== undefined) sc.phase = event.phase;
    if (event.detail !== undefined) sc.detail = event.detail;
    if (event.args !== undefined) sc.args = event.args;
    if (event.resultPreview !== undefined) sc.resultPreview = event.resultPreview;
    if (event.tokens !== undefined) {
      sc.tokens += event.tokens;
      this.totalTokens += event.tokens;
    }
    if (event.tokensIn !== undefined) {
      sc.tokensIn += event.tokensIn;
      this.totalTokensIn += event.tokensIn;
    }
    if (event.tokensOut !== undefined) {
      sc.tokensOut += event.tokensOut;
      this.totalTokensOut += event.tokensOut;
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
  getTotals(): SubcallTotals {
    return { tokens: this.totalTokens, tokensIn: this.totalTokensIn, tokensOut: this.totalTokensOut };
  }

  /**
   * Remove and return every fully-settled root subtree, with its cost/tokens subtracted
   * from the running totals so the caller can add them without double-counting.
   *
   * A root whose subtree still has a running node stays put. That matters because
   * The tree model (`ui/tree/tree-model.ts`) walks down from `parentId === undefined`: a subcall handed
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
    let tokens = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const root of children.get(undefined) ?? []) {
      const subtree = settledSubtree(root);
      if (subtree === undefined) continue;
      for (const node of subtree) {
        tokens += node.tokens;
        tokensIn += node.tokensIn;
        tokensOut += node.tokensOut;
        taken.push(Object.freeze({ ...node, status: node.status }));
        this.subcalls.delete(node.id);
      }
    }
    this.totalTokens -= tokens;
    this.totalTokensIn -= tokensIn;
    this.totalTokensOut -= tokensOut;
    return { subcalls: taken, totals: { tokens, tokensIn, tokensOut } };
  }

  // ── Root usage (delegated from RlmEventAggregator) ──

  /** Accumulate root-level usage into shared totals. Called by aggregator. */
  addRootUsage(tokens: number, tokensIn = 0, tokensOut = 0): void {
    this.totalTokens += tokens;
    this.totalTokensIn += tokensIn;
    this.totalTokensOut += tokensOut;
    this.rootTokens += tokens;
    this.rootTokensIn += tokensIn;
    this.rootTokensOut += tokensOut;
  }

  /** Root engine's OWN spend (driver-model turns only) — never blends sub-call models. */
  getRootUsage(): SubcallTotals {
    return { tokens: this.rootTokens, tokensIn: this.rootTokensIn, tokensOut: this.rootTokensOut };
  }
}
