import type { TelemetryConfig } from "../core/types.ts";
import { resolveMlflowConfig } from "./mlflow-config.ts";
import type { TelemetrySink } from "./sink.ts";

export type { TelemetrySink };

export async function createTelemetrySink(config: TelemetryConfig | undefined): Promise<TelemetrySink | undefined> {
  if (!config) return undefined;
  const resolved = resolveMlflowConfig({ trackingUri: config.trackingUri, experimentId: config.experimentId });
  const enabled = config.enabled ?? Boolean(resolved.trackingUri);
  if (!enabled || !resolved.trackingUri) return undefined;
  const { MlflowSink } = await import("./mlflow-sink.ts");
  return new MlflowSink(resolved, config.maxQueueSize);
}
