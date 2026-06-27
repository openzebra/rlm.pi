/**
 * The `llm_query` / `llm_query_batched` bridge: turns sandbox sub-LLM interrupts into
 * real (serverless) completions on the configured *worker* model, reporting each call to the
 * RlmEmitter for progressive TUI re-rendering.
 *
 * Caps enforce the divide-and-conquer budget from the RLM method: per-prompt size and batch
 * fan-out are bounded, and batches run through a fixed-size concurrency pool.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { modelRef, resolveModelId } from "../config/settings.ts";
import type { Sampling } from "../core/types.ts";
import { type ChatMsg, modelComplete } from "./model.ts";
import { previewText } from "../text/preview.ts";
import { formatError, isErrorText } from "../util/errors.ts";
import { mapPool } from "../util/concurrency.ts";

export interface LlmBridgeOptions {
  readonly workerModel: Model<Api>;
  readonly registry: ModelRegistry;
  readonly subSystem?: string;
  readonly maxPromptChars?: number;
  readonly maxConcurrent?: number;
  readonly sampling?: Sampling;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, model: Model<Api>) => void;
  /** Live RlmDetails reporting via onUpdate. */
  readonly emitter?: RlmEmitter;
  readonly parentId?: string;
  readonly depth?: number;
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
  const { emitter } = opts;
  const displayModel = (model: string | null): string =>
    modelRef(model ? (resolveModelId(opts.registry, model) ?? opts.workerModel) : opts.workerModel) ?? opts.workerModel.id;

  // Run one completion; report cost/tokens via `track` (a per-call or per-batch accumulator).
  async function complete1(prompt: string, model: string | null, track: (u: Usage) => void): Promise<string> {
    if (prompt.length > maxPromptChars) {
      return formatError(`sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ${maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`);
    }
    const resolved = model ? resolveModelId(opts.registry, model) : undefined;
    if (model && !resolved) return formatError(`unknown model override '${model}'`);
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
      return formatError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    async llmQuery(prompt, model) {
      const id = emitter?.emitSubcallCreated({
        kind: "llm", parentId: opts.parentId, label: "llm_query",
        model: displayModel(model), args: `prompt: ${previewText(prompt)}`,
        depth: opts.depth ?? 0,
      });
      let cost = 0;
      let tokens = 0;
      const out = await complete1(prompt, model, (u) => {
        cost += u.cost.total;
        tokens += u.totalTokens;
      });
      if (emitter && id !== undefined) emitter.emitSubcallUpdated({ id,
        status: isErrorText(out) ? "error" : "done",
        costUsd: cost, tokens, resultPreview: previewText(out),
        detail: isErrorText(out) ? out : undefined,
      });
      return out;
    },

    async llmQueryBatched(prompts, model) {
      const id = emitter?.emitSubcallCreated({
        kind: "batch", parentId: opts.parentId, label: `llm_query ×${prompts.length}`,
        model: displayModel(model), args: `prompt: ${previewText(prompts[0] ?? "")}`,
        depth: opts.depth ?? 0,
      });
      let cost = 0;
      let tokens = 0;
      const out = await mapPool(prompts, maxConcurrent, (p) =>
        complete1(p, model, (u) => {
          cost += u.cost.total;
          tokens += u.totalTokens;
        }),
      );
      const failed = out.filter(isErrorText).length;
      const error = failed === out.length && out.length > 0
        ? `all ${out.length} sub-calls failed`
        : failed > 0 ? `${failed}/${out.length} sub-calls failed` : undefined;
      const firstPreview = previewText(out[0] ?? "");
      const resultPreview = out.length > 1 ? `${firstPreview}  (+${out.length - 1} more)` : firstPreview;
      if (emitter && id !== undefined) emitter.emitSubcallUpdated({ id,
        status: error ? "error" : "done", costUsd: cost, tokens,
        resultPreview, detail: error,
      });
      return out;
    },
  };
}
