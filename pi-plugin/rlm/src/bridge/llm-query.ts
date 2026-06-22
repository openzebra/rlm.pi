/**
 * The `llm_query` / `llm_query_batched` bridge: turns sandbox sub-LLM interrupts into
 * real (serverless) completions on the configured *worker* model, reporting each call to the
 * AgentTree via a SubcallObserver.
 *
 * Caps enforce the divide-and-conquer budget from the RLM method: per-prompt size and batch
 * fan-out are bounded, and batches run through a fixed-size concurrency pool.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { NOOP_OBSERVER, type SubcallObserver } from "../state/events.ts";
import type { Sampling } from "../core/types.ts";
import { type ChatMsg, modelComplete } from "./model.ts";

export interface LlmBridgeOptions {
  workerModel: Model<Api>;
  registry: ModelRegistry;
  subSystem?: string;
  maxPromptChars?: number;
  maxConcurrent?: number;
  sampling?: Sampling;
  signal?: AbortSignal;
  onUsage?: (usage: Usage, model: Model<Api>) => void;
  /** Tree reporting. `parentId`/`depth` place sub-call nodes under the issuing run. */
  observer?: SubcallObserver;
  parentId?: string;
  depth?: number;
}

const DEFAULT_MAX_PROMPT_CHARS = 400_000;
const DEFAULT_MAX_CONCURRENT = 4;

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

export interface LlmBridge {
  llmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  llmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

function preview(prompt: string): string {
  const firstLine = prompt.replace(/\s+/g, " ").trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

export function createLlmBridge(opts: LlmBridgeOptions): LlmBridge {
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const observer = opts.observer ?? NOOP_OBSERVER;
  const depth = opts.depth ?? 0;

  // Run one completion; report cost/tokens via `track` (a per-call or per-batch accumulator).
  async function complete1(prompt: string, track: (u: Usage) => void): Promise<string> {
    if (prompt.length > maxPromptChars) {
      return `Error: sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ${maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`;
    }
    try {
      const messages: ChatMsg[] = [{ role: "user", content: prompt }];
      const res = await modelComplete(messages, {
        model: opts.workerModel,
        registry: opts.registry,
        system: opts.subSystem,
        maxTokens: opts.sampling?.maxTokens,
        temperature: opts.sampling?.temperature,
        reasoning: opts.sampling?.reasoning,
        signal: opts.signal,
      });
      opts.onUsage?.(res.usage, opts.workerModel);
      track(res.usage);
      return res.text;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    async llmQuery(prompt) {
      const id = observer.start({ kind: "llm", depth, parentId: opts.parentId, model: opts.workerModel.id, label: "llm_query", detail: preview(prompt) });
      let cost = 0;
      let tokens = 0;
      const out = await complete1(prompt, (u) => {
        cost += u.cost.total;
        tokens += u.totalTokens;
      });
      observer.end(id, { costUsd: cost, tokens, error: out.startsWith("Error:") ? out : undefined });
      return out;
    },

    async llmQueryBatched(prompts) {
      const id = observer.start({ kind: "batch", depth, parentId: opts.parentId, model: opts.workerModel.id, label: `llm_query ×${prompts.length}`, detail: preview(prompts[0] ?? "") });
      let cost = 0;
      let tokens = 0;
      const out = await mapPool(prompts, maxConcurrent, (p) =>
        complete1(p, (u) => {
          cost += u.cost.total;
          tokens += u.totalTokens;
        }),
      );
      observer.end(id, { costUsd: cost, tokens });
      return out;
    },
  };
}
