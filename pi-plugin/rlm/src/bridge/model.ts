/**
 * modelComplete — a single, serverless, in-process LLM completion.
 *
 * This is the one place that talks to a provider. It resolves the API key from pi's
 * ModelRegistry (keys live here, never in the sandbox) and calls pi-ai's `completeSimple`,
 * wrapped in completeWithRetry: transient 429/5xx get exponential backoff (honoring
 * `retry-after` via the onResponse hook) and rate limits additionally cool the shared
 * per-provider throttle. Used both for `llm_query` (one user prompt) and for the headless
 * RLM root (full history).
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { type Api, completeSimple, type Message, type Model, type ThinkingLevel, type Usage } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeWithRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../util/retry.ts";

type Role = "system" | "user" | "assistant";
export interface ChatMsg {
  readonly role: Role;
  readonly content: string;
}

export interface CompleteOptions {
  readonly model: Model<Api>;
  readonly registry: ModelRegistry;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: ThinkingLevel;
  readonly signal?: AbortSignal;
  /** Retry + adaptive throttle for transient 429/5xx; defaults apply when omitted. */
  readonly retry?: RetryPolicy;
  /** v5.1 UX: fired while parked on the rate-limit cooldown ("queued") / when released. */
  readonly onThrottlePark?: (ms: number) => void;
  readonly onThrottleRelease?: () => void;
}

export interface CompleteResult {
  readonly text: string;
  readonly usage: Usage;
}

/** Build a synthetic AssistantMessage (pi-ai requires the full shape for history replay). */
function assistantMessage(text: string, model: Model<Api>): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toPiMessages(messages: readonly ChatMsg[], model: Model<Api>): { readonly systemPrompt?: string; readonly messages: Message[] } {
  // System segments joined once below — no quadratic re-copy of the accumulated prompt (rule:
  // never build large text with `+`/template concat inside a loop).
  const systemParts: string[] = [];
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: Date.now() });
    } else {
      out.push(assistantMessage(m.content, model));
    }
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { systemPrompt, messages: out };
}

/**
 * Explicit reasoning gate. pi-ai clamps unsupported levels too (a model with `reasoning:
 * false` supports only "off", so any requested level clamps to it and nothing goes out on
 * the wire) — owning the gate here makes the behavior engine policy, testable without a
 * provider, and drops the option outright instead of forwarding a level the model cannot
 * honor. Capability comes from the registry entry, never from config.
 */
export function effectiveReasoning(model: Model<Api>, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  const clamped = clampThinkingLevel(model, level);
  return clamped === "off" ? undefined : clamped;
}

/** Extract the assistant's plain text from a completion. */
function extractText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

export async function modelComplete(messages: readonly ChatMsg[], opts: CompleteOptions): Promise<CompleteResult> {
  const auth = await opts.registry.getApiKeyAndHeaders(opts.model);
  if (!auth.ok) throw new Error(`auth for ${opts.model.provider}/${opts.model.id}: ${auth.error}`);

  const built = toPiMessages(messages, opts.model);
  const systemPrompt = opts.system
    ? built.systemPrompt
      ? `${opts.system}\n\n${built.systemPrompt}`
      : opts.system
    : built.systemPrompt;

  const msg = await completeWithRetry(
    async (note) => {
      const response = await completeSimple(
        opts.model,
        { systemPrompt, messages: built.messages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          reasoning: effectiveReasoning(opts.model, opts.reasoning),
          signal: opts.signal,
          onResponse: (res) => { note(res.status, res.headers); },
        },
      );
      // pi-ai folds provider failures into the message: "error"/"aborted" + errorMessage.
      // Throwing here puts every completion failure onto ONE path — the retry classifier.
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? response.stopReason);
      }
      return response;
    },
    { policy: opts.retry ?? DEFAULT_RETRY_POLICY, provider: opts.model.provider, signal: opts.signal, onPark: opts.onThrottlePark, onRelease: opts.onThrottleRelease },
  );
  return { text: extractText(msg.content), usage: msg.usage };
}
