export interface MlflowConfig {
  readonly trackingUri?: string;
  readonly experimentId?: string;
  readonly trackingToken?: string;
}

const readEnv = (key: string): string | undefined => process.env[key]?.trim() || undefined;

export function resolveMlflowConfig(config: Pick<MlflowConfig, "trackingUri" | "experimentId">): MlflowConfig {
  return {
    trackingUri: readEnv("MLFLOW_TRACKING_URI") || config.trackingUri,
    experimentId: readEnv("MLFLOW_EXPERIMENT_ID") || config.experimentId,
    trackingToken: readEnv("MLFLOW_TRACKING_TOKEN"),
  };
}
