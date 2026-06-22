/**
 * The `rlm_query` recursion bridge.
 *
 * A child RLM gets its own sandbox and iterates over the prompt as its context. At/over the
 * depth cap it degrades to a plain `llm_query` (ported from rlm/core/rlm.py `_subcall`). The
 * concurrency pool bounds parallel children for `rlm_query_batched`.
 */

import type { RunRlm } from "../core/types.ts";
import type { LlmBridge } from "./llm-query.ts";

export interface RlmHandlers {
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

export interface RlmBridgeOptions {
  run: RunRlm;
  llm: LlmBridge;
  maxDepth: number;
  maxConcurrent: number;
  /** AgentTree node of the current run; recursive children attach under it. */
  parentNodeId?: string;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function createRlmHandlers(opts: RlmBridgeOptions): RlmHandlers {
  async function child(prompt: string, model: string | null, depth: number): Promise<string> {
    const childDepth = depth + 1;
    // At the cap, a child RLM would just be an LM — short-circuit to a one-shot llm_query.
    if (childDepth >= opts.maxDepth) return opts.llm.llmQuery(prompt, model, depth);
    try {
      const res = await opts.run({ rootPrompt: "", context: prompt, depth: childDepth, parentNodeId: opts.parentNodeId });
      return res.answer;
    } catch (err) {
      return `Error: child RLM failed - ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    rlmQuery: (prompt, model, depth) => child(prompt, model, depth),
    rlmQueryBatched: (prompts, model, depth) => mapPool(prompts, opts.maxConcurrent, (p) => child(p, model, depth)),
  };
}
