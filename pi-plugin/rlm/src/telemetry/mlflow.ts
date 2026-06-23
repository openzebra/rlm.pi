import { flushTraces, init, type LiveSpan, startSpan as mlflowStartSpan, SpanStatusCode, SpanType } from "@mlflow/core";
import { resolveMlflowConfig, type MlflowConfig } from "./mlflow-config.ts";

export { type LiveSpan, type MlflowConfig, SpanStatusCode, SpanType };

export function msToNs(ms: number): number {
  return ms * 1_000_000;
}

export interface StartSpanOptions<S> {
  readonly name: string;
  readonly spanType: SpanType;
  readonly parent?: S;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly startTimeNs?: number;
}

export interface EndSpanOptions {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly status?: SpanStatusCode;
  readonly endTimeNs?: number;
}

export interface SpanTracer<S = unknown> {
  startSpan(options: StartSpanOptions<S>): S | undefined;
  endSpan(span: S, options?: EndSpanOptions): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export class MlflowTracer implements SpanTracer<LiveSpan> {
  private initialized = false;
  private initAttempted = false;

  constructor(private readonly config: MlflowConfig) {}

  startSpan(options: StartSpanOptions<LiveSpan>): LiveSpan | undefined {
    if (!this.ensureInit()) return undefined;
    const span = mlflowStartSpan({
      name: options.name,
      spanType: options.spanType,
      ...(options.parent ? { parent: options.parent } : {}),
      ...(options.inputs ? { inputs: options.inputs } : {}),
      ...(options.startTimeNs !== undefined ? { startTimeNs: options.startTimeNs } : {}),
    });
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) span.setAttribute(key, value);
    }
    return span;
  }

  endSpan(span: LiveSpan, options: EndSpanOptions = {}): void {
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) span.setAttribute(key, value);
    }
    span.end({
      ...(options.outputs ? { outputs: options.outputs } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.endTimeNs !== undefined ? { endTimeNs: options.endTimeNs } : {}),
    });
  }

  async flush(): Promise<void> {
    if (!this.initialized) return;
    try {
      await flushTraces();
    } catch (err) {
      console.warn(`[rlm-telemetry] mlflow flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }

  private ensureInit(): boolean {
    if (this.initialized || this.initAttempted) return this.initialized;
    this.initAttempted = true;
    const resolved = resolveMlflowConfig(this.config);
    if (!resolved.trackingUri) {
      console.warn("[rlm-telemetry] MLFLOW_TRACKING_URI unset — spans dropped");
      return false;
    }

    try {
      init({
        trackingUri: resolved.trackingUri,
        experimentId: resolved.experimentId ?? "0",
        ...(resolved.trackingToken ? { trackingServerToken: resolved.trackingToken } : {}),
      });
      this.initialized = true;
    } catch (err) {
      console.warn(`[rlm-telemetry] mlflow init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.initialized;
  }
}
