/**
 * Trajectory compaction (port of rlm/core/rlm.py `_compact_history`).
 *
 * When the root history grows past a fraction of the model's context window, replace the middle
 * of the conversation with a single running summary — a bounded-memory recap (the linear-space
 * idea from DP sequence alignment). Keeps the system message + a fresh "continue" instruction.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { estimateMessageTokens } from "../text/tokens.ts";

const SUMMARY_REQUEST =
  "Summarize your progress so far. Include: (1) which sub-tasks are done and which remain; " +
  "(2) any concrete intermediate results — numbers, values, variable names — preserved exactly; " +
  "(3) your next action. Be concise (1–3 paragraphs) but preserve all key results.";

export interface CompactionDeps {
  model: Model<Api>;
  registry: ModelRegistry;
  contextWindow: number;
  thresholdPct?: number;
  signal?: AbortSignal;
}

/** True if the history is at/over the compaction threshold. */
export function shouldCompact(history: ChatMsg[], deps: CompactionDeps): boolean {
  const threshold = (deps.thresholdPct ?? 0.85) * deps.contextWindow;
  return estimateMessageTokens(history) >= threshold;
}

/**
 * Summarize the trajectory and return a compacted history: [system, summary(assistant),
 * continue(user)]. The caller continues appending turns from there.
 */
export async function compactHistory(history: ChatMsg[], deps: CompactionDeps, count = 1): Promise<ChatMsg[]> {
  const { text: summary } = await modelComplete([...history, { role: "user", content: SUMMARY_REQUEST }], {
    model: deps.model,
    registry: deps.registry,
    signal: deps.signal,
  });
  const system = history.find((m) => m.role === "system");
  const head: ChatMsg[] = system ? [system] : [];
  return [
    ...head,
    { role: "assistant", content: summary },
    {
      role: "user",
      content:
        `Your conversation has been compacted ${count} time(s). Continue from the summary above. ` +
        "Do NOT repeat completed work. Use SHOW_VARS() to see existing REPL variables. Your next action:",
    },
  ];
}
