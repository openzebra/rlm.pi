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
import { resolveModelId } from "../config/settings.ts";
import type { Sampling } from "../core/types.ts";
import { type ChatMsg, modelComplete } from "./model.ts";
import { previewText } from "../text/preview.ts";
import { mapPool } from "../util/concurrency.ts";

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

export interface LlmBridge {
  llmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  llmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

export function createLlmBridge(opts: LlmBridgeOptions): LlmBridge {
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const observer = opts.observer ?? NOOP_OBSERVER;
  const depth = opts.depth ?? 0;

  // Run one completion; report cost/tokens via `track` (a per-call or per-batch accumulator).
  async function complete1(prompt: string, model: string | null, track: (u: Usage) => void): Promise<string> {
    if (prompt.length > maxPromptChars) {
      return `Error: sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ${maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`;
    }
    const resolved = model ? resolveModelId(opts.registry, model) : undefined;
    if (model && !resolved) return `Error: unknown model override '${model}'`;
    try {
      const messages: ChatMsg[] = [{ role: "user", content: prompt }];
      const res = await modelComplete(messages, {
        model: resolved ?? opts.workerModel,
        registry: opts.registry,
        system: opts.subSystem,
        maxTokens: opts.sampling?.maxTokens,
        temperature: opts.sampling?.temperature,
        reasoning: opts.sampling?.reasoning,
        signal: opts.signal,
      });
      opts.onUsage?.(res.usage, resolved ?? opts.workerModel);
      track(res.usage);
      return res.text;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    async llmQuery(prompt, model) {
      const id = observer.start({ kind: "llm", depth, parentId: opts.parentId, model: opts.workerModel.id, label: "llm_query", args: `prompt: ${previewText(prompt)}` });
      let cost = 0;
      let tokens = 0;
      const out = await complete1(prompt, model, (u) => {
        cost += u.cost.total;
        tokens += u.totalTokens;
      });
      observer.end(id, { costUsd: cost, tokens, error: out.startsWith("Error:") ? out : undefined, resultPreview: previewText(out) });
      return out;
    },

    async llmQueryBatched(prompts, model) {
      const id = observer.start({ kind: "batch", depth, parentId: opts.parentId, model: opts.workerModel.id, label: `llm_query ×${prompts.length}`, args: `prompt: ${previewText(prompts[0] ?? "")}` });
      let cost = 0;
      let tokens = 0;
      const out = await mapPool(prompts, maxConcurrent, (p) =>
        complete1(p, model, (u) => {
          cost += u.cost.total;
          tokens += u.totalTokens;
        }),
      );
      const failed = out.filter((o) => o.startsWith("Error:")).length;
      const error = failed === out.length && out.length > 0
        ? `all ${out.length} sub-calls failed`
        : failed > 0 ? `${failed}/${out.length} sub-calls failed` : undefined;
      const firstPreview = previewText(out[0] ?? "");
      const resultPreview = out.length > 1 ? `${firstPreview}  (+${out.length - 1} more)` : firstPreview;
      observer.end(id, { costUsd: cost, tokens, error, resultPreview });
      return out;
    },
  };
}
