/**
 * Trajectory compaction (port of rlm/core/rlm.py `_compact_history`).
 *
 * When the root history grows past a fraction of the model's context window, replace the middle
 * of the conversation with a single running summary — a bounded-memory recap (the linear-space
 * idea from DP sequence alignment). Keeps the system message + a fresh "continue" instruction.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import type { RetryPolicy } from "../util/retry.ts";
import { estimateMessageTokens } from "../text/tokens.ts";
import type { RunState } from "../core/run-state.ts";
import { compactJSON } from "../core/run-state.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;

const SUMMARY_REQUEST =
  "Summarize your progress so far. Include: (1) which sub-tasks are done and which remain; " +
  "(2) any concrete intermediate results — numbers, values, variable names — preserved exactly; " +
  "(3) your next action. Be concise (1–3 paragraphs) but preserve all key results.";

interface CompactionDeps {
  readonly model: Model<Api>;
  readonly registry: ModelRegistry;
  readonly contextWindow?: number;
  readonly thresholdPct?: number;
  readonly signal?: AbortSignal;
  /** v5.1 retry policy for modelComplete; defaults apply when omitted. */
  readonly retry?: RetryPolicy;
}

/** True if the history is at/over the compaction threshold. */
export function shouldCompact(history: ChatMsg[], deps: CompactionDeps): boolean {
  const contextWindow = deps.contextWindow && deps.contextWindow > 0 ? deps.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const threshold = (deps.thresholdPct ?? 0.85) * contextWindow;
  return estimateMessageTokens(history) >= threshold;
}

/**
 * v5 G1: elide old tool/repl payload bodies, keep the head (system) and the working-set tail
 * intact. Runs BEFORE `shouldCompact` — v3 measured −97% tokens on coding tasks with this
 * alone, often avoiding the summarizer entirely. Head-ONLY elision was a measured v3 bug
 * (turns grew 3→8): the tail carries the current working set, so the last `keepTurns` turns
 * are never touched.
 */
export function elideOldToolPayloads(
  history: ChatMsg[],
  keepTurns = 2,
  toolChars = 1_500,
): ChatMsg[] {
  if (history.length === 0) return history;
  // Find the assistant message that starts the keepTurns-th-from-last turn; everything from
  // there on is the protected tail.
  let tailStart = 0;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      seen++;
      if (seen >= keepTurns) {
        tailStart = i;
        break;
      }
    }
  }
  if (tailStart === 0) return history; // fewer turns than keepTurns — nothing to elide
  let changed = false;
  const marker = "\n…[elided v5-G1]…";
  const out: ChatMsg[] = new Array<ChatMsg>(history.length); // pre-allocated
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (
      i < tailStart &&
      m.role === "user" &&
      m.content.length > toolChars
    ) {
      out[i] = { role: "user", content: m.content.slice(0, toolChars) + marker };
      changed = true;
    } else {
      out[i] = m;
    }
  }
  return changed ? out : history;
}

/**
 * Summarize the trajectory and return a compacted history: [system, summary(assistant),
 * continue(user)]. The caller continues appending turns from there.
 */
export async function compactHistory(
  history: ChatMsg[],
  deps: CompactionDeps,
  count = 1,
  onUsage?: (u: Usage) => void,
): Promise<ChatMsg[]> {
  const { text: summary, usage } = await modelComplete([...history, { role: "user", content: SUMMARY_REQUEST }], {
    model: deps.model,
    registry: deps.registry,
    signal: deps.signal,
    retry: deps.retry,
  });
  onUsage?.(usage);
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

/** Same protected-tail rule as elideOldToolPayloads: the working set survives verbatim. */
const REBASE_KEEP_TURNS = 2;

/**
 * Workstream A: structural rebase — the SKILL.state replacement for the LLM summary path.
 *
 *   history := [ P , user("[Σ] …") , window(O) ]
 *
 * Everything older than the protected tail is superseded by the EXACT execution state — no
 * model call is made at all (the summarizer LLM call disappears by design; the `compactions`
 * counter still moves so telemetry stays comparable). Failure semantics: pure function, no
 * fallible operations — the degraded path keeps `compactHistory` for as-built runs.
 */
export function rebaseWithState(history: ChatMsg[], state: RunState, count = 1): ChatMsg[] {
  const system = history.find((m) => m.role === "system");
  const head: ChatMsg[] = system ? [system] : [];
  let tailStart = history.length;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      seen += 1;
      if (seen >= REBASE_KEEP_TURNS) {
        tailStart = i;
        break;
      }
    }
  }
  const window: ChatMsg[] = tailStart < history.length ? history.slice(tailStart) : [];
  return [
    ...head,
    {
      role: "user",
      content:
        `Your conversation was structurally rebased ${count} time(s): older turns are superseded ` +
        `by the exact execution state below — do NOT repeat completed work; fresh tool results ` +
        `outrank Σ when they disagree.\n[Σ] ${compactJSON(state)}`,
    },
    ...window,
  ];
}
