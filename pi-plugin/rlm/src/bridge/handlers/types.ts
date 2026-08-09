/**
 * Shared types for the async-by-default subcall handler set.
 *
 * Every subcall (llm_query, llm_batch, rlm_query, rlm_batch) returns a SpawnResult
 * immediately with a task_id. The model must call await(task_id) to collect the
 * real answer. This contract is proven in rlm_test (api_v5 + batch, scores 0.89–1.0).
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RlmInput, RlmResult, Sampling } from "../../core/types.ts";
import type { SubcallGates } from "../../util/concurrency.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import type { RlmEmitter } from "../../tool/rlm-events.ts";

// ---------------------------------------------------------------------------
// Spawn / Await / Finish — the three shapes the model sees
// ---------------------------------------------------------------------------

/** Returned by every spawn: llm_query, llm_batch, rlm_query, rlm_batch. */
export interface SpawnResult {
  readonly ok: boolean;
  readonly task_id: string | null;
  readonly kind: "llm" | "rlm" | "llm_batch" | "rlm_batch";
  /** Number of sub-tasks in this batch (1 for singles). */
  readonly n: number;
  readonly status: "pending";
  /** Hint text reminding the model to await. */
  readonly hint: string;
  readonly error?: string;
}

/** Returned by await(task_id) or await(task_ids=[...]). */
export interface AwaitResult {
  readonly ok: boolean;
  readonly task_id: string;
  readonly kind: string;
  readonly status: "done" | "error" | "timeout";
  /** Single result (llm_query, rlm_query). */
  readonly result?: string;
  /** Ordered batch results (llm_batch, rlm_batch). */
  readonly results?: readonly string[];
  readonly error?: string;
}

/** Returned by finish(summary) — the contract boundary. */
export interface FinishResult {
  readonly ok: true;
  readonly finished: true;
}

// ---------------------------------------------------------------------------
// Invocation — per-call context (emitter, limits, depth)
// ---------------------------------------------------------------------------

export interface InvocationLimits {
  remainingTimeoutMs(): number | undefined;
  addUsage(usage: Usage): void;
  addRaw(costUsd: number, inputTokens: number, outputTokens: number): void;
}

export function limitsFromRemaining(
  remaining?: () => { readonly timeoutMs?: number },
): InvocationLimits {
  return Object.freeze({
    remainingTimeoutMs: () => remaining?.().timeoutMs,
    addUsage: (_usage: Usage) => {},
    addRaw: (_costUsd: number, _inputTokens: number, _outputTokens: number) => {},
  });
}

export interface Invocation {
  readonly emitter: RlmEmitter;
  readonly parentId: string | undefined;
  readonly depth: number;
  readonly limits: InvocationLimits;
}

// ---------------------------------------------------------------------------
// Handler dependencies — supplied by the engine or repl() tool
// ---------------------------------------------------------------------------

export interface SubcallConfig {
  readonly maxPromptChars: number;
  readonly maxDepth: number;
  readonly subSampling?: Sampling;
  readonly subSystemPrompt?: string;
}

export interface SubcallHandlerDeps {
  /** Resolve the invocation for a given interrupt (emitter + limits). */
  readonly resolve: (opts: SubcallOpts, depth: number) => Invocation | null;
  /** Session-wide concurrency gates. */
  readonly gates: SubcallGates;
  readonly registry: ModelRegistry;
  readonly getLlmModel: () => Model<Api>;
  readonly getConfig: () => SubcallConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
  // Recursion
  readonly runChild?: (input: RlmInput, inv: Invocation) => Promise<RlmResult>;
  readonly getChildContext?: () => unknown;
  readonly getModel?: () => Model<Api>;
  readonly degrade?: (prompt: string, depth: number) => Promise<string>;
  readonly onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
  readonly trackDetached?: <T>(run: () => Promise<T>) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Handler set returned to the sandbox (canonical names only)
// ---------------------------------------------------------------------------

/** Canonical api_v5 handler set — no legacy aliases. */
export interface SubcallHandlers {
  readonly llmQuery: (prompt: string, depth: number, opts: SubcallOpts) => Promise<SpawnResult>;
  readonly llmBatch: (prompts: readonly string[], depth: number, opts: SubcallOpts) => Promise<SpawnResult>;
  readonly rlmQuery: (task: string, depth: number, opts: SubcallOpts) => Promise<SpawnResult>;
  readonly rlmBatch: (tasks: readonly string[], depth: number, opts: SubcallOpts) => Promise<SpawnResult>;
  readonly awaitTask: (taskId: string | undefined, taskIds: readonly string[] | undefined, timeoutS: number | undefined, depth: number, opts: SubcallOpts) => Promise<AwaitResult>;
  readonly finishTask: (summary: string, depth: number, opts: SubcallOpts) => Promise<FinishResult>;
}

// ---------------------------------------------------------------------------
// Task registry entry — tracks in-flight spawns
// ---------------------------------------------------------------------------

export interface TaskEntry {
  readonly taskId: string;
  readonly kind: "llm" | "rlm" | "llm_batch" | "rlm_batch";
  readonly n: number;
  status: "pending" | "done" | "error" | "timeout";
  result?: string;
  results?: readonly string[];
  error?: string;
  readonly createdAt: number;
}
