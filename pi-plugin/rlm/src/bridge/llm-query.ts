/**
 * The `llm_query` / `llm_query_batched` bridge: turns sandbox sub-LLM interrupts into
 * real (serverless) completions on the configured *worker* model, reporting each call to the
 * RlmEmitter for progressive TUI re-rendering.
 *
 * Caps enforce the divide-and-conquer budget from the RLM method: per-prompt size and batch
 * fan-out are bounded, and batches run through a fixed-size concurrency pool.
 *
 * Every input that can change between calls (worker model, emitter, parent node, depth,
 * remaining budget) is an accessor, so a single bridge instance serves both the headless
 * engine — which binds them once per run — and the native `repl` tool, which swaps them per
 * invocation without recreating the sandbox.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { displayModelRef, resolveModelId } from "../config/settings.ts";
import { checkResourceLimits, type RemainingResources } from "../core/resource-limits.ts";
import type { Sampling } from "../core/types.ts";
import { type ChatMsg, modelComplete } from "./model.ts";
import { previewText } from "../text/preview.ts";
import { errorMessage, formatError, isErrorText } from "../util/errors.ts";
import { mapPool } from "../util/concurrency.ts";

/**
 * The config slice this bridge reads. Structurally satisfied by `RlmConfig`, and re-read on
 * every call so `/rlm-config` changes take effect without rebuilding the sandbox.
 */
export interface LlmBridgeConfig {
  readonly maxPromptChars: number;
  readonly maxConcurrentSubcalls: number;
  readonly subSystemPrompt?: string;
  readonly subSampling?: Sampling;
}

export interface LlmBridgeOptions {
  /** Resolved per call so provider/config changes between calls are picked up. */
  readonly workerModel: () => Model<Api>;
  readonly registry: ModelRegistry;
  readonly config: () => LlmBridgeConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, model: Model<Api>) => void;
  /** Parent run's remaining budget/timeout; checked before every sub-call. */
  readonly remainingBudget?: () => RemainingResources | undefined;
  /** Live RlmDetails reporting target, resolved per call. */
  readonly emitter?: () => RlmEmitter | undefined;
  readonly parentId?: () => string | undefined;
  readonly depth?: () => number;
}

/** Provider failures that a smaller batch or a cheaper model might get past. */
const RETRYABLE_HINT = /credit|402|payment|quota|rate.limit/i;

export interface LlmBridge {
  llmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  llmQueryBatched(prompts: readonly string[], model: string | null, depth: number): Promise<string[]>;
}

/** Batch outcome summary, or undefined when every prompt succeeded. */
function batchError(failed: number, total: number): string | undefined {
  if (failed === 0) return undefined;
  return failed === total
    ? `all ${total} sub-calls failed — reduce batch size or try llm_query individually`
    : `${failed}/${total} sub-calls failed`;
}

export function createLlmBridge(opts: LlmBridgeOptions): LlmBridge {
  const displayModel = (model: string | null): string =>
    displayModelRef(opts.registry, model, opts.workerModel());

  // Run one completion; report cost/tokens via `track` (a per-call or per-batch accumulator).
  async function complete1(prompt: string, model: string | null, track: (u: Usage) => void): Promise<string> {
    const config = opts.config();
    const rem = opts.remainingBudget?.();
    if (rem !== undefined) {
      const limitError = checkResourceLimits(rem);
      if (limitError !== undefined) return limitError;
    }
    if (prompt.length > config.maxPromptChars) {
      return formatError(`sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ${config.maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`);
    }
    const resolved = model ? resolveModelId(opts.registry, model) : undefined;
    if (model && !resolved) return formatError(`unknown model override '${model}'`);
    const target = resolved ?? opts.workerModel();
    try {
      const messages: ChatMsg[] = [{ role: "user", content: prompt }];
      const res = await modelComplete(messages, {
        model: target,
        registry: opts.registry,
        system: config.subSystemPrompt,
        maxTokens: config.subSampling?.maxTokens,
        temperature: config.subSampling?.temperature,
        reasoning: config.subSampling?.reasoning,
        signal: opts.signal,
      });
      opts.onUsage?.(res.usage, target);
      track(res.usage);
      return res.text;
    } catch (err) {
      const msg = errorMessage(err);
      const hint = RETRYABLE_HINT.test(msg) ? " — try smaller batches or individual llm_query calls" : "";
      return formatError(`${msg}${hint}`);
    }
  }

  return {
    async llmQuery(prompt, model) {
      const emitter = opts.emitter?.();
      const id = emitter?.emitSubcallCreated({
        kind: "llm", parentId: opts.parentId?.(), label: "llm_query",
        model: displayModel(model), args: `prompt: ${previewText(prompt)}`,
        depth: opts.depth?.() ?? 0,
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
      const emitter = opts.emitter?.();
      const id = emitter?.emitSubcallCreated({
        kind: "batch", parentId: opts.parentId?.(), label: `llm_query ×${prompts.length}`,
        model: displayModel(model), args: `prompt: ${previewText(prompts[0] ?? "")}`,
        depth: opts.depth?.() ?? 0,
      });
      let cost = 0;
      let tokens = 0;
      const out = await mapPool(prompts, opts.config().maxConcurrentSubcalls, (p) =>
        complete1(p, model, (u) => {
          cost += u.cost.total;
          tokens += u.totalTokens;
        }),
      );
      const failed = out.filter(isErrorText).length;
      const error = batchError(failed, out.length);
      const firstPreview = previewText(out[0] ?? "");
      const resultPreview = out.length > 1 ? `${firstPreview}  (+${out.length - 1} more)` : firstPreview;
      if (emitter && id !== undefined) emitter.emitSubcallUpdated({ id,
        status: error ? "error" : "done", costUsd: cost, tokens,
        resultPreview, detail: error,
        failedCount: failed, totalCount: out.length,
      });
      return out;
    },
  };
}
