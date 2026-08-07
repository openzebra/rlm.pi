/**
 * The `rlm_query` recursion bridge.
 *
 * A child RLM gets its own sandbox and iterates over the prompt as its context. At/over the
 * depth cap it degrades to a plain `llm_query` (ported from rlm/core/rlm.py `_subcall`). The
 * concurrency pool bounds parallel children for `rlm_query_batched`.
 *
 * As with the llm bridge, everything that can change between calls is an accessor, so the
 * headless engine (which binds them once per run) and the native `repl` tool (which swaps them
 * per invocation) share one implementation.
 */

import type { RlmResult, RunRlm } from "../core/types.ts";
import type { LlmBridge } from "./llm-query.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { checkResourceLimits, type RemainingResources } from "../core/resource-limits.ts";
import { errorMessage, formatError } from "../util/errors.ts";
import { mapPool } from "../util/concurrency.ts";
import { previewText } from "../text/preview.ts";

/** The config slice this bridge reads; structurally satisfied by `RlmConfig`. */
export interface RlmBridgeConfig {
  readonly maxDepth: number;
  readonly maxConcurrentSubcalls: number;
}

export interface RlmHandlers {
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: readonly string[], model: string | null, depth: number): Promise<string[]>;
}

export interface RlmBridgeOptions {
  /**
   * Spawns one child run. The engine passes its own `run` (self-recursion); the native tool
   * passes a closure that builds a child engine bound to the current invocation's emitter.
   */
  readonly run: RunRlm;
  readonly llm: LlmBridge;
  readonly config: () => RlmBridgeConfig;
  /** "provider/id" shown on the sub-call node; see `displayModelRef` in config/settings.ts. */
  readonly modelLabel?: (override: string | null) => string;
  /** Live RlmDetails reporting target, resolved per call. */
  readonly emitter: () => RlmEmitter | undefined;
  /** Parent subcall ID that this run is attached under, resolved per call. */
  readonly parentNodeId?: () => string | undefined;
  /** Returns the parent's remaining budget/timeout for seeding child runs. */
  readonly remainingBudget?: () => RemainingResources | undefined;
  /** Called with a child run's total cost/tokens so the parent LimitGuard debits it. */
  readonly onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
}

export function createRlmHandlers(opts: RlmBridgeOptions): RlmHandlers {
  /**
   * One child spawn. `childDepth` is the absolute depth the child will run at.
   * Never throws: failures come back as "Error: ..." strings, matching the sandbox contract.
   */
  async function child(prompt: string, model: string | null, childDepth: number): Promise<string> {
    // At the cap, a child RLM would just be an LM — short-circuit to a one-shot llm_query.
    if (childDepth >= opts.config().maxDepth) {
      return opts.llm.llmQuery(prompt, model, childDepth - 1);
    }

    const rem = opts.remainingBudget?.();
    if (rem !== undefined) {
      // Pre-spawn guard: refuse if the parent's budget or timeout is already exhausted
      // (reference: _subcall checks remaining_budget/timeout before spawning).
      const limitError = checkResourceLimits(rem);
      if (limitError !== undefined) return limitError;
    }

    const emitter = opts.emitter();
    const subId = emitter?.emitSubcallCreated({
      kind: "rlm", parentId: opts.parentNodeId?.(), label: "rlm_query",
      model: opts.modelLabel?.(model) ?? model ?? undefined,
      detail: prompt.slice(0, 60),
      depth: childDepth,
    });

    try {
      const res: RlmResult = await opts.run({
        rootPrompt: "",
        context: prompt,
        depth: childDepth,
        parentNodeId: subId,
        modelOverride: model ?? undefined,
        remainingBudgetUsd: rem?.budgetUsd,
        remainingTimeoutMs: rem?.timeoutMs,
      });
      opts.onChildUsage?.(res.costUsd, res.inputTokens, res.outputTokens);
      // The child emits live cost/token deltas on the shared emitter as it runs, so the node
      // must NOT also receive a final aggregate — that would double-count.
      if (emitter && subId !== undefined) {
        emitter.emitSubcallUpdated({ id: subId, status: "done", resultPreview: previewText(res.answer) });
      }
      return res.answer;
    } catch (err) {
      const msg = errorMessage(err);
      if (emitter && subId !== undefined) emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
      return formatError(`child RLM failed - ${msg}`);
    }
  }

  return {
    rlmQuery: (prompt, model, depth) => child(prompt, model, depth + 1),
    rlmQueryBatched: (prompts, model, depth) =>
      mapPool(prompts, opts.config().maxConcurrentSubcalls, (p) => child(p, model, depth + 1)),
  };
}
