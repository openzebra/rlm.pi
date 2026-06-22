/**
 * modelComplete — a single, serverless, in-process LLM completion.
 *
 * This is the one place that talks to a provider. It resolves the API key from pi's
 * ModelRegistry (keys live here, never in the sandbox) and calls pi-ai's `completeSimple`.
 * Used both for `llm_query` (one user prompt) and for the headless RLM root (full history).
 */

import { type Api, completeSimple, type Message, type Model, type ThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type Role = "system" | "user" | "assistant";
export interface ChatMsg {
  role: Role;
  content: string;
}

export interface CompleteOptions {
  model: Model<Api>;
  registry: ModelRegistry;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
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

function toPiMessages(messages: ChatMsg[], model: Model<Api>): { systemPrompt?: string; messages: Message[] } {
  let systemPrompt: string | undefined;
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${m.content}` : m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: Date.now() });
    } else {
      out.push(assistantMessage(m.content, model));
    }
  }
  return { systemPrompt, messages: out };
}

/** Extract the assistant's plain text from a completion. */
function extractText(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

export async function modelComplete(messages: ChatMsg[], opts: CompleteOptions): Promise<CompleteResult> {
  const auth = await opts.registry.getApiKeyAndHeaders(opts.model);
  if (!auth.ok) throw new Error(`auth for ${opts.model.provider}/${opts.model.id}: ${auth.error}`);

  const built = toPiMessages(messages, opts.model);
  const systemPrompt = opts.system
    ? built.systemPrompt
      ? `${opts.system}\n\n${built.systemPrompt}`
      : opts.system
    : built.systemPrompt;

  const msg = await completeSimple(
    opts.model,
    { systemPrompt, messages: built.messages },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoning: opts.reasoning,
      signal: opts.signal,
    },
  );
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(msg.errorMessage ?? msg.stopReason);
  }
  return { text: extractText(msg.content), usage: msg.usage };
}
