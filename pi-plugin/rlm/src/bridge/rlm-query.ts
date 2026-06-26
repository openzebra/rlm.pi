/**
 * The `rlm_query` recursion bridge.
 *
 * A child RLM gets its own sandbox and iterates over the prompt as its context. At/over the
 * depth cap it degrades to a plain `llm_query` (ported from rlm/core/rlm.py `_subcall`). The
 * concurrency pool bounds parallel children for `rlm_query_batched`.
 */

import type { RunRlm } from "../core/types.ts";
import type { LlmBridge } from "./llm-query.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { mapPool } from "../util/concurrency.ts";

export interface RlmHandlers {
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

export interface RlmBridgeOptions {
  run: RunRlm;
  llm: LlmBridge;
  /** Live RlmDetails reporting via onUpdate. Required — replaces SubcallObserver for recursive subcalls. */
  emitter: RlmEmitter;
  maxDepth: number;
  maxConcurrent: number;
  /** Parent subcall ID that this run is attached under. */
  parentNodeId?: string;
  /** Returns the parent's remaining budget/timeout for seeding child runs. */
  remainingBudget?: () => { budgetUsd?: number; timeoutMs?: number };
  /** Called with a child run's total cost/tokens so the parent LimitGuard debits it. */
  onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
}

export function createRlmHandlers(opts: RlmBridgeOptions): RlmHandlers {
  async function child(prompt: string, model: string | null, depth: number): Promise<string> {
    const childDepth = depth + 1;
    // At the cap, a child RLM would just be an LM — short-circuit to a one-shot llm_query.
    if (childDepth >= opts.maxDepth) return opts.llm.llmQuery(prompt, model, depth);
    let subId: string | undefined;
    try {
      const rem = opts.remainingBudget?.() ?? {};
      // Pre-spawn guard: refuse if the parent's budget or timeout is already exhausted
      // (reference: _subcall checks remaining_budget/timeout before spawning).
      if (rem.budgetUsd !== undefined && rem.budgetUsd <= 0) return "Error: budget exhausted";
      if (rem.timeoutMs !== undefined && rem.timeoutMs <= 0) return "Error: timeout exhausted";
      subId = opts.emitter.emitSubcallCreated({
        kind: "rlm", parentId: opts.parentNodeId, label: "rlm_query",
        model: model ?? undefined, detail: prompt.slice(0, 60),
        depth: childDepth,
      });
      const res = await opts.run({
        rootPrompt: "",
        context: prompt,
        depth: childDepth,
        parentNodeId: subId,
        smartModelOverride: model ?? undefined,
        remainingBudgetUsd: rem.budgetUsd,
        remainingTimeoutMs: rem.timeoutMs,
      });
      opts.onChildUsage?.(res.costUsd, res.inputTokens, res.outputTokens);
      opts.emitter.emitSubcallUpdated({ id: subId,
        status: "done", resultPreview: res.answer.slice(0, 200),
      });
      return res.answer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (subId) opts.emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
      return `Error: child RLM failed - ${msg}`;
    }
  }

  return {
    rlmQuery: (prompt, model, depth) => child(prompt, model, depth),
    rlmQueryBatched: (prompts, model, depth) => mapPool(prompts, opts.maxConcurrent, (p) => child(p, model, depth)),
  };
}
