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

/** r3 single bench model: Qwen3.8 27B hybrid thinker — thinking enabled per-run via the
 *  `--reasoning` flag (ROOT/RLM agent only; sub-LLM never gets reasoning), 1M-token context.
 *  Verified to drive the repl protocol AND use llm_query delegation when grep misses. */
export const DEFAULT_MODEL_REF = "openrouter/qwen/qwen3.8-27b";

/** Advertised context window for the default model (qwen3.8-27b: 1M). Override via
 *  RLM_BENCH_CONTEXT_WINDOW when switching models. Only load-bearing if enableTokenBudget is
 *  ever re-enabled (it is off) — plus provider-side safety. */
const BENCH_CONTEXT_WINDOW = Number(process.env.RLM_BENCH_CONTEXT_WINDOW ?? 1_000_000);

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

export interface BenchPricing {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Real per-token USD pricing from OpenRouter's public model catalog (no auth, fail fast).
 *  Cost is a required bench feature: a model missing from the catalog throws instead of
 *  silently journaling $0 rows. */
export async function fetchPricing(modelId: string): Promise<BenchPricing> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`openrouter pricing fetch failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const entry = data.find((m): m is Record<string, unknown> => isRecord(m) && m.id === modelId);
  if (entry === undefined) throw new Error(`unknown model on OpenRouter: ${modelId}`);
  const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
  const inputPerToken = Number(pricing?.prompt);
  const outputPerToken = Number(pricing?.completion);
  if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) {
    throw new Error(`openrouter pricing for ${modelId} is unparseable: ${JSON.stringify(pricing ?? null)}`);
  }
  return Object.freeze({ inputPerToken, outputPerToken });
}

export interface BenchRunOpts {
  /** Default BENCH_MAX_ITERATIONS (12). */
  readonly maxIterations?: number;
  /** Default 0 — bench runs stay deterministic where the provider allows it. */
  readonly temperature?: number;
  /** ThinkingLevel for the ROOT (RLM agent) only; omit = no thinking. Sub-LLM (subSampling)
   *  NEVER gets reasoning — the worker model has none. */
  readonly reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Real USD-per-token prices (see fetchPricing); default zeros (only listings run without). */
  readonly pricing?: BenchPricing;
}

export function makeRun(target: BenchTarget, apiKey: string, opts?: BenchRunOpts): RunRlm {
  const model = {
    id: target.id,
    provider: target.provider,
    api: "openai-completions" as const,
    name: target.id,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: opts?.reasoning !== undefined,
    input: ["text"] as const,
    cost: {
      input: opts?.pricing?.inputPerToken ?? 0,
      output: opts?.pricing?.outputPerToken ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
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
    maxIterations: opts?.maxIterations ?? BENCH_MAX_ITERATIONS,
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
    // Reasoning tokens share the completion budget, so the root budget doubles when thinking
    // is on. Sub-sampling NEVER carries reasoning (worker model has none).
    rootSampling: Object.freeze({
      maxTokens: opts?.reasoning !== undefined ? 8192 : 4096,
      temperature: opts?.temperature ?? 0,
      ...(opts?.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
    }),
    subSampling: Object.freeze({ maxTokens: 2048, temperature: opts?.temperature ?? 0 }),
  };

  return createEngine({
    model,
    llmModel: model,
    registry,
    config,
    emitter: new RlmEmitter(),
  });
}
