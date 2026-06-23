export interface DispatcherSink<E> {
  readonly name: string;
  handle(event: E): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface DispatcherOptions {
  readonly maxQueueSize: number;
}

/** Bounded FIFO async dispatcher with drop-oldest backpressure. */
export class Dispatcher<E> {
  private readonly sinks: DispatcherSink<E>[] = [];
  private queue: E[] = [];
  private flushing = false;
  private inFlight: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private backpressureActive = false;
  private readonly failed = new Set<string>();

  constructor(private readonly options: DispatcherOptions) {}

  registerSink(sink: DispatcherSink<E>): () => void {
    this.sinks.push(sink);
    return () => {
      const idx = this.sinks.indexOf(sink);
      if (idx >= 0) this.sinks.splice(idx, 1);
    };
  }

  dispatch(event: E): void {
    if (this.shuttingDown || this.sinks.length === 0) return;
    const cap = this.options.maxQueueSize;
    if (this.queue.length >= cap) {
      this.queue.shift();
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        console.warn(`[rlm-telemetry] backpressure: queue saturated at ${cap}; dropping oldest events`);
      }
    } else if (this.backpressureActive && this.queue.length < cap - 1) {
      this.backpressureActive = false;
      console.warn("[rlm-telemetry] backpressure recovered: queue back under capacity");
    }
    this.queue.push(event);
    this.scheduleFlush();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const remaining = this.queue;
    this.queue = [];
    this.flushing = false;

    await this.inFlight;

    for (const event of remaining) await this.broadcast(event);
    const sinks = [...this.sinks];
    await Promise.allSettled(sinks.map((sink) => sink.flush()));
    await Promise.allSettled(sinks.map((sink) => sink.shutdown()));
  }

  reset(): void {
    this.sinks.length = 0;
    this.queue = [];
    this.flushing = false;
    this.inFlight = Promise.resolve();
    this.shuttingDown = false;
    this.backpressureActive = false;
    this.failed.clear();
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = true;
    this.drain();
  }

  private drain(): void {
    if (this.queue.length === 0) {
      this.flushing = false;
      return;
    }
    const batch = this.queue;
    this.queue = [];

    this.inFlight = this.inFlight.then(async () => {
      for (const event of batch) await this.broadcast(event);
      if (this.queue.length > 0) {
        const handle = setImmediate(() => this.drain());
        handle.unref?.();
      } else {
        this.flushing = false;
      }
    });
  }

  private async broadcast(event: E): Promise<void> {
    const sinks = [...this.sinks];
    const results = await Promise.allSettled(sinks.map((sink) => sink.handle(event)));
    results.forEach((result, idx) => {
      const name = sinks[idx]?.name;
      if (!name) return;
      if (result.status === "rejected") {
        if (!this.failed.has(name)) {
          this.failed.add(name);
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.warn(`[rlm-telemetry] sink ${name} rejected event: ${reason}`);
        }
      } else if (this.failed.has(name)) {
        this.failed.delete(name);
        console.warn(`[rlm-telemetry] sink ${name} recovered`);
      }
    });
  }
}
