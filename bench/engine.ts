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
import type { SkillStore } from "../pi-plugin/rlm/src/config/skillstate.ts";
import { RlmEmitter } from "../pi-plugin/rlm/src/tool/rlm-events.ts";
import type { RlmConfig, RunRlm, Sampling } from "../pi-plugin/rlm/src/core/types.ts";

type BenchModel = EngineDeps["model"];
type BenchRegistry = EngineDeps["registry"];

/** r3 single bench model: Qwen3.8 27B, 1M-token context. Agent taxonomy (user, 2025-09-10):
 *  root (Pi dialog) thinks; the RLM root thinks (benchSampling pins an explicit level);
 *  llm sub-workers never think — pi-ai turns a missing level into each dialect's explicit
 *  no-thinking directive. Verified to drive the repl protocol AND use llm_query delegation. */
export const DEFAULT_MODEL_REF = "openrouter/qwen/qwen3.8-27b";

/** Advertised context window for the default model (qwen3.8-27b: 1M). Override via
 *  RLM_BENCH_CONTEXT_WINDOW when switching models. Only load-bearing if enableTokenBudget is
 *  ever re-enabled (it is off) — plus provider-side safety. */
const BENCH_CONTEXT_WINDOW = Number(process.env.RLM_BENCH_CONTEXT_WINDOW ?? 1_000_000);

/** Roomier than the interactive default: a bench turn may need several repl blocks.
 *  (Unfinished repl block → 0 score.) */
// 200, not 16: the 16-cap all-failed oolong mid-retrieval (median iterations equaled the cap
// even for PASSED runs, and the model saw "Turn N/16" every turn and rushed). 200 = the old
// interactive default; still overridable per-run via bench/run.ts --max-iterations <N>.
const BENCH_MAX_ITERATIONS = 200;

export interface BenchTarget {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  /** OpenAI-compatible chat-completions base URL (no trailing slash). */
  readonly baseUrl: string;
}

/** Z.ai (bigmodel.cn) free-tier models speak the OpenAI protocol at /api/paas/v4. */
// Coding-plan endpoint is the only channel where glm-4.7 avoids 429 (plan §0 probe:
// global/china plain channels are balance-gated for non-flash models, 2025-09-09).
const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Accepts "openrouter/<id>" / "zai/<id>" (project ref convention) or a bare "<id>";
 *  openrouter implied for bare ids. */
export function resolveTarget(raw: string): BenchTarget {
  const id = raw.trim().replace(/^openrouter\//, "");
  if (id !== raw.trim()) {
    return Object.freeze({
      ref: `openrouter/${id}`,
      provider: "openrouter",
      id,
      contextWindow: BENCH_CONTEXT_WINDOW,
      baseUrl: OPENROUTER_BASE_URL,
    });
  }
  const zaiId = raw.trim().replace(/^zai\//, "");
  if (zaiId !== raw.trim()) {
    return Object.freeze({
      ref: `zai/${zaiId}`,
      provider: "zai",
      id: zaiId,
      contextWindow: BENCH_CONTEXT_WINDOW,
      baseUrl: ZAI_BASE_URL,
    });
  }
  return Object.freeze({
    ref: `openrouter/${id}`,
    provider: "openrouter",
    id,
    contextWindow: BENCH_CONTEXT_WINDOW,
    baseUrl: OPENROUTER_BASE_URL,
  });
}

/** The ONLY key transport is the environment. Fail fast with an actionable message. */
export function requireApiKey(provider = "openrouter"): string {
  const envVar = provider === "zai" ? "ZAI_API_KEY" : "OPENROUTER_API_KEY";
  const key = process.env[envVar];
  if (!key || key.trim().length === 0) {
    throw new Error(
      `${envVar} is not set. Export it first — env vars are the only key transport:\n` +
        `  export ${envVar}=... && bun run bench/run.ts`,
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
  /** Override the default 200-turn budget with a finite cap (A/B arm). */
  readonly maxIterations?: number;
  /** Model ref for the llm tier (llm_query leaves + compaction summarizer); default = main.
   *  Agent taxonomy: root/rlm think, the llm worker never does (dialect-level directive). */
  readonly subModel?: string;
  /** Default 0 — bench runs stay deterministic where the provider allows it. */
  readonly temperature?: number;
  /** Real USD-per-token prices (see fetchPricing); default zeros (only listings run without). */
  readonly pricing?: BenchPricing;
  /** Hydrated SkillState store — without it the ON arm's SkillState features are inert
   *  (engine runs as-built whenever deps.skillStore is undefined). Wire from run.ts. */
  readonly skillStore?: SkillStore;
}

/**
 * The bench's sampling assembly, pure and exported for the bench↔engine parity test
 * (test/phase-bench-parity.ts). makeRun freezes these straight into RlmConfig.
 *
 * Agent taxonomy (user, 2025-09-10): root = Pi dialog orchestrator (thinks); rlm = engine
 * root, calls rlm_query/llm_query and THINKS (explicit effort pinned here); llm = weak
 * sub-worker, thinking DISABLED — no reasoning field on subSampling, so pi-ai's dialect
 * layer emits each provider's explicit off-directive. No per-provider branches.
 */
export function benchSampling(opts?: BenchRunOpts): { readonly root: Sampling; readonly sub: Sampling } {
  const temperature = opts?.temperature ?? 0;
  return {
    // rlm root: thinking ON at the user's standing cross-dialect effort. Reasoning tokens
    // share the completion budget, hence the doubled maxTokens (8192, not 4096).
    root: Object.freeze({
      maxTokens: 8192,
      temperature,
      reasoning: "medium",
    }),
    // llm worker: no reasoning field — the dialect layer emits explicit disabled.
    sub: Object.freeze({ maxTokens: 2048, temperature }),
  };
}

export function makeRun(target: BenchTarget, apiKey: string, opts?: BenchRunOpts): RunRlm {
  // Agent taxonomy (user, 2025-09-10): root/rlm — thinking orchestrator; llm — weak sub-worker
  // with thinking DISABLED. Same construction shape for both (one makeModel, no branches);
  // only the id (and thus the dialect-level thinking directive) differs.
  const makeModel = (id: string): BenchModel =>
    ({
      id,
      provider: target.provider,
      api: "openai-completions" as const,
      name: id,
      baseUrl: target.baseUrl,
      // Capability flag, not a switch: lets pi-ai translate "no reasoningEffort" into the
      // provider dialect's EXPLICIT no-thinking directive (see benchSampling doctrine note).
      reasoning: true,
      input: ["text"] as const,
      // pi-ai's calculateCost expects rates in USD per MILLION tokens; OpenRouter prices are
      // USD per token — convert here, at the only place units meet (×1e6, not ÷).
      cost: {
        input: (opts?.pricing?.inputPerToken ?? 0) * 1_000_000,
        output: (opts?.pricing?.outputPerToken ?? 0) * 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: target.contextWindow,
      maxTokens: 8192,
    }) as unknown as BenchModel;
  const model = makeModel(target.id);
  const llmModel = makeModel(opts?.subModel ?? target.id);

  // pi-ai receives auth through the registry (modelComplete → getApiKeyAndHeaders); the key
  // stays in this closure and is never persisted anywhere.
  const registry = {
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey, headers: {} }),
    find: () => undefined,
    getAvailable: () => [model, llmModel],
    getAll: () => [model, llmModel],
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
    autoSeedCwd: false, // tasks carry explicit context; never sweep the repo into a run
    // Paper-tier tasks carry 100–400k-char contexts; the budget cascade caps a task at
    // contextWindow × budgetShare (≈33k tokens on a 131k window) — below the raw context
    // alone, making big tasks structurally unwinnable. The cascade is its own feature with
    // unit tests (test/budget.ts); the bench measures capability, so it runs without it.
    // Runs stay bounded by maxIterations (200) + maxErrors.
    enableTokenBudget: false,
    // A/B toggles: RLM_BENCH_NO_RUNSTATE=1 / RLM_BENCH_NO_SKILLSTATE=1 revert the
    // corresponding integration (Σ-state compaction / persistent skill grounding) to the
    // pre-integration baseline. Defaults follow DEFAULT_CONFIG (both ON).
    enableRunState: process.env.RLM_BENCH_NO_RUNSTATE !== "1",
    enableSkillState: process.env.RLM_BENCH_NO_SKILLSTATE !== "1",
    // Sampling comes from the ONE bench assembly (benchSampling) — the parity test drives it
    // through the real engine so the two wirings cannot drift.
    rootSampling: benchSampling(opts).root,
    subSampling: benchSampling(opts).sub,
  };

  return createEngine({
    model,
    llmModel,
    registry,
    config,
    emitter: new RlmEmitter(),
    ...(opts?.skillStore === undefined ? {} : { skillStore: opts.skillStore }),
  });
}
