/**
 * Shared test utilities.
 *
 * The mock model / registry / usage / repl-fence fixtures below were duplicated per suite; they
 * live here so a suite that needs to drive a real engine without a network does not re-declare
 * them. Keep new fixtures here rather than copying them into a second suite.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RlmResult } from "../src/core/types.ts";

let failures = 0;

export function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

export function fail(): void {
  failures++;
}

export function failureCount(): number {
  return failures;
}

/** A usage record that costs nothing — for scripted completions that never hit a provider. */
export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const MOCK_MODEL = {
  id: "mock",
  provider: "test",
  api: "openai-completions" as const,
  name: "mock",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as unknown as Model<Api>;

export const MOCK_REGISTRY = {
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "x", headers: {} }),
  find: () => undefined,
} as unknown as ModelRegistry;

/** Wrap code in the fenced block the engine's turn parser looks for. */
export function repl(code: string): string {
  return "```repl\n" + code + "\n```";
}

/** A zero-cost child result, for tests that only care about the RlmInput a child received. */
export function emptyChildResult(answer = "child"): RlmResult {
  return Object.freeze({
    answer, iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0,
  });
}
