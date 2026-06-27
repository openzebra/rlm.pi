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
  }

  // ── Read ──

  /** Snapshot subcall array. Allocates a new array from Map values. */
  getSubcalls(): RlmSubcall[] {
    return Array.from(this.subcalls.values(), (subcall) => Object.freeze({ ...subcall, status: subcall.status as SubcallStatus }));
  }

  /** Snapshot running totals. O(1). */
  getTotals(): { readonly costUsd: number; readonly tokens: number } {
    return { costUsd: this.totalCostUsd, tokens: this.totalTokens };
  }

  // ── Root usage (delegated from RlmEventAggregator) ──

  /** Accumulate root-level usage into shared totals. Called by aggregator. */
  addRootUsage(costUsd: number, tokens: number): void {
    this.totalCostUsd += costUsd;
    this.totalTokens += tokens;
  }
}
