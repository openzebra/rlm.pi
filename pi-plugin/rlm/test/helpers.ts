/**
 * Shared test utilities.
 *
 * The mock model / registry / usage / repl-fence fixtures below were duplicated per suite; they
 * live here so a suite that needs to drive a real engine without a network does not re-declare
 * them. Keep new fixtures here rather than copying them into a second suite.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChatMsg, CompleteOptions } from "../src/bridge/model.ts";
import type { CompleteFn } from "../src/core/iteration.ts";
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
  contextWindow: 262_144, // ≥ BUDGET_WINDOW_FLOOR so engine-level cascade tests keep firing
  maxTokens: 4096,
} as unknown as Model<Api>;

export const MOCK_REGISTRY = {
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "x", headers: {} }),
  find: () => undefined,
  // 0.84.x migration: registry is constructed via `new ModelRegistry(runtime)`; the old
  // `ModelRegistry.create(AuthStorage.create())` helper is gone. Tests that only need a
  // registry for wiring (getAvailable/cheapestModel) can use these mock rows.
  getAvailable: () => [MOCK_MODEL],
  getAll: () => [MOCK_MODEL],
} as unknown as ModelRegistry;

/** Wrap code in the fenced block the engine's turn parser looks for. */
export function repl(code: string): string {
  return "```repl\n" + code + "\n```";
}

/** One intercepted model completion: the history and the exact options it was called with. */
export interface CapturedCall {
  readonly messages: readonly ChatMsg[];
  readonly opts: CompleteOptions;
}

/**
 * A CompleteFn that RECORDS every call's second argument (the CompleteOptions carrying
 * model/registry/maxTokens/temperature/reasoning) and replays scripted responses in order
 * (the last one repeats when the script runs dry). Production passes the options object as
 * the 2nd argument of CompleteFn (core/iteration.ts); 1-arg test mocks drop it — use this
 * when a suite must assert the sampling that actually reaches the model call.
 */
export function captureComplete(responses: readonly string[]): {
  readonly complete: CompleteFn;
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let served = 0;
  const complete: CompleteFn = async (messages, opts) => {
    // Snapshot: the engine mutates its history array in place (appendUserMessage/push), so a
    // stored reference would alias every root turn to the final state.
    calls[calls.length] = { messages: [...messages], opts };
    const text = responses[Math.min(served, responses.length - 1)] ?? "";
    served += 1;
    return { text, usage: ZERO_USAGE };
  };
  return { complete, calls };
}

/** A zero-cost child result, for tests that only care about the RlmInput a child received. */
export function emptyChildResult(answer = "child"): RlmResult {
  return Object.freeze({
    answer, iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0,
  });
}
