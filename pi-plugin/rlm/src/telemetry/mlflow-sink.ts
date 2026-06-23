import type { NodeKind } from "../state/agent-tree.ts";
import type { SubcallStart } from "../state/events.ts";
import { Dispatcher, type DispatcherSink } from "./dispatcher.ts";
import {
  MlflowTracer,
  msToNs,
  SpanStatusCode,
  SpanType,
  type MlflowConfig,
  type SpanTracer,
} from "./mlflow.ts";
import type { TelemetrySink } from "./sink.ts";

// @mlflow/core keeps process-global trace state. RLM telemetry uses one shared
// tracer per process and should not be combined with another MLflow init path in
// the same host process.
let sharedTracer: MlflowTracer | undefined;
function tracerFor(config: MlflowConfig): MlflowTracer {
  sharedTracer ??= new MlflowTracer(config);
  return sharedTracer;
}

const SPAN_TYPE: Readonly<Record<NodeKind, SpanType>> = Object.freeze({
  root: SpanType.AGENT,
  rlm: SpanType.AGENT,
  llm: SpanType.CHAT_MODEL,
  batch: SpanType.CHAT_MODEL,
  tool: SpanType.TOOL,
});

type SpanOp =
  | { readonly kind: "start"; readonly id: string; readonly info: SubcallStart; readonly tsMs: number }
  | { readonly kind: "usage"; readonly id: string; readonly costUsd: number; readonly tokens: number }
  | { readonly kind: "end"; readonly id: string; readonly error?: string; readonly resultPreview?: string; readonly tsMs: number };

class SpanApplier<S> implements DispatcherSink<SpanOp> {
  readonly name = "rlm-mlflow";
  private readonly spans = new Map<string, S>();
  private readonly usage = new Map<string, { cost: number; tokens: number }>();

  constructor(private readonly tracer: SpanTracer<S>) {}

  async handle(op: SpanOp): Promise<void> {
    if (op.kind === "start") {
      const parent = op.info.parentId ? this.spans.get(op.info.parentId) : undefined;
      const span = this.tracer.startSpan({
        name: op.info.label,
        spanType: SPAN_TYPE[op.info.kind],
        parent,
        inputs: {
          ...(op.info.model ? { model: op.info.model } : {}),
          ...(op.info.detail ? { detail: op.info.detail } : {}),
        },
        attributes: {
          "rlm.kind": op.info.kind,
          "rlm.depth": op.info.depth,
          ...(op.info.model ? { "rlm.model": op.info.model } : {}),
        },
        startTimeNs: msToNs(op.tsMs),
      });
      if (span !== undefined) this.spans.set(op.id, span);
      return;
    }

    if (op.kind === "usage") {
      const usage = this.usage.get(op.id) ?? { cost: 0, tokens: 0 };
      this.usage.set(op.id, { cost: usage.cost + op.costUsd, tokens: usage.tokens + op.tokens });
      return;
    }

    this.closeSpan(op.id, {
      outputs: op.resultPreview ? { result: op.resultPreview } : undefined,
      status: op.error ? SpanStatusCode.ERROR : undefined,
      endTimeNs: msToNs(op.tsMs),
    });
  }

  async flush(): Promise<void> {
    await this.tracer.flush();
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.spans.keys()]) this.closeSpan(id, { status: SpanStatusCode.ERROR });
    await this.tracer.flush();
  }

  private closeSpan(
    id: string,
    opts: { readonly outputs?: Readonly<Record<string, unknown>>; readonly status?: SpanStatusCode; readonly endTimeNs?: number },
  ): void {
    const span = this.spans.get(id);
    if (span === undefined) return;
    const usage = this.usage.get(id);
    this.tracer.endSpan(span, {
      ...(usage ? { attributes: { "rlm.usage.cost_usd": usage.cost, "rlm.usage.tokens": usage.tokens } } : {}),
      ...opts,
    });
    this.spans.delete(id);
    this.usage.delete(id);
  }
}

export class MlflowSink implements TelemetrySink {
  private readonly dispatcher: Dispatcher<SpanOp>;

  constructor(config: MlflowConfig, maxQueueSize = 100, tracer: SpanTracer = tracerFor(config)) {
    this.dispatcher = new Dispatcher<SpanOp>({ maxQueueSize });
    this.dispatcher.registerSink(new SpanApplier(tracer));
  }

  start(id: string, info: SubcallStart): void {
    if (id) this.dispatcher.dispatch({ kind: "start", id, info, tsMs: Date.now() });
  }

  usage(id: string, costUsd: number, tokens: number): void {
    if (id) this.dispatcher.dispatch({ kind: "usage", id, costUsd, tokens });
  }

  end(id: string, opts?: { readonly error?: string; readonly resultPreview?: string }): void {
    if (id) {
      this.dispatcher.dispatch({
        kind: "end",
        id,
        error: opts?.error,
        resultPreview: opts?.resultPreview,
        tsMs: Date.now(),
      });
    }
  }

  shutdown(): Promise<void> {
    return this.dispatcher.shutdown();
  }
}
