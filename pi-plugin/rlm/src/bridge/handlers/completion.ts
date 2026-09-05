/**
 * Single LLM completion — the ONE place a sub-LLM call is made.
 *
 * Every leaf completion takes exactly ONE slot on `gates.leaf` here.
 * Never wrap a whole batch in the leaf gate (deadlock); only complete1 acquires it.
 *
 * AGENTS.md DRY #1: complete1 exists once. Never inline another one.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, modelComplete } from "../model.ts";
import { checkResourceLimits } from "../../core/resource-limits.ts";
import { errorMessage, formatError } from "../../util/errors.ts";
import { retryPolicy } from "../../util/retry.ts";
import type { Semaphore } from "../../util/concurrency.ts";
import type { Invocation, SubcallConfig, SubcallHandlerDeps } from "./types.ts";

interface Complete1Deps {
  readonly leafGate: Semaphore;
  readonly registry: ModelRegistry;
  readonly getLlmModel: () => Model<Api>;
  readonly getConfig: () => SubcallConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
}

/**
 * AGENTS.md DRY: the ONE projection of SubcallHandlerDeps for complete1 — shared verbatim by
 * the llm-query and rlm-query handlers. Never inline a second copy.
 */
export function completeDeps(deps: SubcallHandlerDeps): Complete1Deps {
  return {
    leafGate: deps.gates.leaf,
    registry: deps.registry,
    getLlmModel: deps.getLlmModel,
    getConfig: deps.getConfig,
    signal: deps.signal,
    onUsage: deps.onUsage,
  };
}

/**
 * Run one LLM completion inside the leaf gate.
 * Never throws — returns formatError(...) strings on failure.
 */
export async function complete1(
  inv: Invocation,
  prompt: string,
  track: (usage: Usage) => void,
  deps: Complete1Deps,
  hooks?: { readonly onThrottlePark?: (ms: number) => void; readonly onThrottleRelease?: () => void },
): Promise<string> {
  const config = deps.getConfig();
  const limitError = checkResourceLimits({
    timeoutMs: inv.limits.remainingTimeoutMs(),
  });
  if (limitError !== undefined) return limitError;
  if (prompt.length > config.maxPromptChars) {
    return formatError(
      `sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ` +
        `${config.maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`,
    );
  }
  try {
    const messages: ChatMsg[] = [{ role: "user", content: prompt }];
    const res = await deps.leafGate.run(() =>
      modelComplete(messages, {
        model: deps.getLlmModel(),
        registry: deps.registry,
        system: config.subSystemPrompt,
        maxTokens: config.subSampling?.maxTokens,
        temperature: config.subSampling?.temperature,
        reasoning: config.subSampling?.reasoning,
        retry: retryPolicy(config),
        onThrottlePark: hooks?.onThrottlePark,
        onThrottleRelease: hooks?.onThrottleRelease,
        signal: deps.signal,
      }),
    );
    inv.limits.addUsage(res.usage);
    deps.onUsage?.(res.usage, "sub");
    track(res.usage);
    return res.text;
  } catch (err: unknown) {
    const msg = errorMessage(err);
    const hint = /credit|402|payment|quota|rate.limit/i.test(msg)
      ? " — try smaller batches or individual llm_query calls"
      : "";
    return formatError(`${msg}${hint}`);
  }
}
