/**
 * Bench engine wiring — builds a real, network-backed RLM engine for benchmark runs.
 *
 * The model/registry pair mirrors the MOCK_* fixtures in pi-plugin/rlm/test/helpers.ts, but
 * points at a real provider (OpenRouter). The API key is read from the environment at call
 * time and is never written to disk, logs, or the journal — env vars are the only key
 * transport. Omitting `complete` makes the engine use `modelComplete` (real provider I/O).
 */

// Types are derived from EngineDeps (NOT imported from @earendil-works/* directly): the
// plugin resolves its own nested node_modules copy, so a direct import would bind a second,
// incompatible copy of the Model/ModelRegistry types from the repo-root package.
import { createEngine, type EngineDeps } from "../pi-plugin/rlm/src/core/engine.ts";
import { DEFAULT_CONFIG } from "../pi-plugin/rlm/src/config/defaults.ts";
import { RlmEmitter } from "../pi-plugin/rlm/src/tool/rlm-events.ts";
import type { RlmConfig, RunRlm } from "../pi-plugin/rlm/src/core/types.ts";

type BenchModel = EngineDeps["model"];
type BenchRegistry = EngineDeps["registry"];

/** Cheap paid model for stable runs (no free-pool mid-stream kills): $0.08/$0.45 per M.
 *  Verified to drive the repl protocol AND use llm_query delegation when grep misses. */
export const DEFAULT_MODEL_REF = "openrouter/google/gemma-3-27b-it";

/** Advertised context window for the default model (131k). Override via RLM_BENCH_CONTEXT_WINDOW
 *  when switching models. */
const BENCH_CONTEXT_WINDOW = Number(process.env.RLM_BENCH_CONTEXT_WINDOW ?? 131_072);

/** Roomier than the interactive default: a bench turn may need a few repl blocks, but a
 *  free little model should never burn 30 turns on one task. */
const BENCH_MAX_ITERATIONS = 12;

export interface BenchTarget {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

/** Accepts "openrouter/<id>" (project ref convention) or a bare "<id>"; openrouter implied. */
export function resolveTarget(raw: string): BenchTarget {
  const id = raw.trim().replace(/^openrouter\//, "");
  return Object.freeze({
    ref: `openrouter/${id}`,
    provider: "openrouter",
    id,
    contextWindow: BENCH_CONTEXT_WINDOW,
  });
}

/** The ONLY key transport is the environment. Fail fast with an actionable message. */
export function requireApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it first — env vars are the only key transport:\n" +
        "  export OPENROUTER_API_KEY=sk-or-... && bun run bench/run.ts",
    );
  }
  return key;
}

export function makeRun(target: BenchTarget, apiKey: string): RunRlm {
  const model = {
    id: target.id,
    provider: target.provider,
    api: "openai-completions" as const,
    name: target.id,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: target.contextWindow,
    maxTokens: 8192,
  } as unknown as BenchModel;

  // pi-ai receives auth through the registry (modelComplete → getApiKeyAndHeaders); the key
  // stays in this closure and is never persisted anywhere.
  const registry = {
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey, headers: {} }),
    find: () => undefined,
    getAvailable: () => [model],
    getAll: () => [model],
  } as unknown as BenchRegistry;

  const config: RlmConfig = {
    ...DEFAULT_CONFIG,
    maxIterations: BENCH_MAX_ITERATIONS,
    maxConcurrentSubcalls: 4, // free-tier rate limits are tight; retry/throttle handles the rest
    // Free-pool upstreams flake (transient "finish_reason: error"); a bench row should mean
    // "the model failed the task", not "the pool hiccuped" — so retry harder than interactive.
    retryMaxAttempts: 5,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 30_000,
    enableMemory: false, // keep bench runs isolated from durable notes
    autoSeedCwd: false, // tasks carry explicit context; never sweep the repo into a run
    // Paper-tier tasks carry 100–400k-char contexts; the budget cascade caps a task at
    // contextWindow × budgetShare (≈33k tokens on a 131k window) — below the raw context
    // alone, making big tasks structurally unwinnable. The cascade is its own feature with
    // unit tests (test/budget.ts); the bench measures capability, so it runs without it.
    // Runs stay bounded by maxIterations + maxErrors.
    enableTokenBudget: false,
    rootSampling: Object.freeze({ maxTokens: 4096 }),
    subSampling: Object.freeze({ maxTokens: 2048 }),
  };

  return createEngine({
    model,
    llmModel: model,
    registry,
    config,
    emitter: new RlmEmitter(),
  });
}
