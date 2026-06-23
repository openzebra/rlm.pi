import type { SubcallStart } from "../state/events.ts";

export interface TelemetrySink {
  start(id: string, info: SubcallStart): void;
  usage(id: string, costUsd: number, tokens: number): void;
  end(id: string, opts?: { readonly error?: string; readonly resultPreview?: string }): void;
  shutdown(): Promise<void>;
}
