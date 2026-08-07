/**
 * Sub-call admission control.
 *
 * `spawn()` lets the sandbox put many requests on the wire at once, so a per-call pool no
 * longer bounds anything: one `llm_query_chunked` over a large file posts every batch
 * simultaneously, and each batch fans out again. The bound has to be session-wide, which is
 * what `SubcallGates` is — constructed once at the composition root and shared by every
 * handler.
 */

/**
 * Counting semaphore: at most `limit` holders at once, FIFO.
 *
 * FIFO means a large fan-out is not starved, but also that it is not preempted: a
 * 500-prompt `llm_query_chunked` holds the queue until it drains, so an interactive
 * `llm_query` issued behind it waits for the whole thing. Acceptable while sub-calls are
 * uniform in priority; revisit if an interactive tier is ever added.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Hold a slot for the duration of `fn`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  /** Order-preserving parallel map bounded by this semaphore. */
  map<T, R>(items: readonly T[], fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, idx) => this.run(() => fn(item, idx))));
  }

  /** In-flight holders. Exposed for tests asserting the bound. */
  get inFlight(): number {
    return this.active;
  }
}

/**
 * One semaphore per recursion depth.
 *
 * A single shared gate would deadlock: `limit` rlm_query children holding every slot, each
 * blocked waiting for a grandchild that can never be admitted. Splitting by depth breaks the
 * cycle — a holder at depth k only ever waits on depth k+1. Leaf LLM calls are terminal and
 * never re-enter, so they safely share one process-wide gate.
 */
export class DepthGates {
  private readonly gates = new Map<number, Semaphore>();

  constructor(private readonly limit: number) {}

  at(depth: number): Semaphore {
    let gate = this.gates.get(depth);
    if (gate === undefined) {
      gate = new Semaphore(this.limit);
      this.gates.set(depth, gate);
    }
    return gate;
  }
}

/** Session-wide sub-call admission. Construct once; pass explicitly — never default one in. */
export interface SubcallGates {
  /** llm_query / llm_query_batched completions — terminal, so one shared gate. */
  readonly leaf: Semaphore;
  /** Recursive child engines — one gate per depth, see DepthGates. */
  readonly rlm: DepthGates;
}

/**
 * Worst case is `maxDepth × limit` concurrent child engines (each owning a Python
 * subprocess) plus `limit` leaf completions, so keep `limit` modest — see
 * DEFAULT_CONFIG.maxConcurrentSubcalls.
 */
export function createSubcallGates(limit: number): SubcallGates {
  return Object.freeze({ leaf: new Semaphore(limit), rlm: new DepthGates(limit) });
}
