/**
 * Token budget cascade (port of rlm_test v4/v5 `budget.py`).
 *
 * The budget is the PRIMARY run-length control: cap = budgetShare × model context window,
 * one soft wrap-up turn at `softFrac` of the cap, and at the hard cap a deterministic
 * handoff (`distillTrajectory`) is handed to a fresh continuation run — chain-capped at
 * `maxContinuations`. Wall-clock timeouts stay only as hang backstops.
 *
 * v5 counts the whole tree (root turns + sub-LLM usage) against the cap; the engine feeds
 * the run's LimitGuard totals in via `observeTotal` after every turn. Each continuation
 * starts a fresh spend window (v5's offset-anchoring) — the chain total is bounded by
 * `cap × (1 + maxContinuations)`, never by re-charging prior work.
 */

import type { ChatMsg } from "../bridge/model.ts";
import type { RlmConfig } from "./types.ts";

export interface TokenBudgetOptions {
  readonly softFrac?: number;
  readonly continuations?: number;
  readonly maxContinuations?: number;
}

export type BudgetState = "" | "soft" | "hard";

/** v5 verbatim: the soft wrap-up note prepended to the single turn after crossing soft. */
export const WRAP_UP_BUDGET: string = Object.freeze(
  "[budget] ~80% of your token cap — ONE turn left. If the task is answerable NOW, finalize " +
    '(set answer["ready"] = True). Otherwise print a compact findings dump: what is confirmed, ' +
    "current file/line or search position, and the exact next step — a fresh continuation picks " +
    "it up. Do not start new exploration.",
);

export const DEFAULT_NEXT_STEP: string =
  Object.freeze("continue the probing that was in flight, then finalize");

/** v5 verbatim template (adapting the finalize spelling to this plugin's REPL). */
const HANDOFF_TEMPLATE: string = Object.freeze(
  "A prior RLM run hit its token cap mid-task.\n" +
    "You are its continuation — pick up EXACTLY where it stopped.\n\n" +
    "ORIGINAL TASK:\n{query}\n\n" +
    "CONFIRMED FINDINGS SO FAR:\n{findings}\n\n" +
    "CURRENT STATE / LAST ACTIONS:\n{state}\n\n" +
    "NEXT STEP: {next}\n" +
    "Do not re-do confirmed work; continue from the NEXT STEP and finalize as\n" +
    'soon as the task is answerable (answer["ready"] = True).',
);

/** v5's elision marker, used whenever a handoff section is trimmed. */
const ELISION_MARK = "\n…(+N chars elided [v5 handoff])…\n";

export class TokenBudget {
  readonly cap: number;
  readonly softFrac: number;
  readonly continuations: number;
  readonly maxContinuations: number;
  private spent = 0;

  constructor(cap: number, opts: TokenBudgetOptions = {}) {
    this.cap = Math.max(1, Math.floor(cap));
    this.softFrac = opts.softFrac ?? 0.8;
    this.continuations = opts.continuations ?? 0;
    this.maxContinuations = opts.maxContinuations ?? 2;
  }

  get soft(): number {
    return Math.floor(this.cap * this.softFrac);
  }

  get hard(): number {
    return this.cap;
  }

  /** Tokens charged to this run so far (root + sub-LLM, whole tree). */
  get tokensSpent(): number {
    return this.spent;
  }

  /**
   * Feed the run's cumulative token totals (LimitGuard::usage()) after each turn.
   * Absolute, not incremental: one budget instance observes exactly one run, which is
   * what makes a continuation's fresh instance start from zero (v5 offset anchoring).
   */
  observeTotal(inputTokens: number, outputTokens: number): void {
    this.spent = Math.max(0, inputTokens) + Math.max(0, outputTokens);
  }

  state(): BudgetState {
    if (this.cap <= 0) return "";
    if (this.spent >= this.hard) return "hard";
    if (this.spent >= this.soft) return "soft";
    return "";
  }

  canContinue(): boolean {
    return this.continuations < this.maxContinuations;
  }

  /** Fresh spend window, one step deeper in the chain. */
  nextContinuation(): TokenBudget {
    return new TokenBudget(this.cap, {
      softFrac: this.softFrac,
      continuations: this.continuations + 1,
      maxContinuations: this.maxContinuations,
    });
  }
}

/** Cap derivation (v5 `resolve_budget`): share × context window, clamped by the task cap. */
export function resolveBudget(contextWindow: number | undefined, config: RlmConfig): TokenBudget {
  const ctx = contextWindow !== undefined && contextWindow > 0 ? contextWindow : 32_000;
  const shareCap = Math.floor(ctx * config.budgetShare);
  const cap = config.budgetTaskCap > 0 ? Math.min(shareCap, config.budgetTaskCap) : shareCap;
  return new TokenBudget(Math.max(cap, 1), {
    softFrac: config.budgetSoftFrac,
    maxContinuations: config.budgetMaxContinuations,
  });
}

/**
 * Truncate at the midpoint so both the head and the tail of the content survive
 * (v5 semantics: keep the opening context and the most recent actions).
 */
export function truncateMid(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(0, maxChars - ELISION_MARK.length) >> 1;
  const elided = text.length - (half * 2);
  return text.slice(0, half) + ELISION_MARK.replace("N", String(elided)) + text.slice(text.length - half);
}

const QUERY_CHARS = 800;
const FINDINGS_MAX = 6;
const FINDINGS_MIN_CHARS = 20;
const STATE_MAX = 8;
const STATE_NEEDLE = "REPL stdout";
const NEXT_STEP_RE = /next|then|will |todo/i;

/**
 * Deterministic trajectory → handoff (v5 `distill_trajectory`). No LLM call: the model was
 * just told (soft wrap-up) to print a findings dump, and this harvests it — query, the last
 * substantive assistant findings, the last REPL states, and the next step.
 */
export function distillTrajectory(
  history: readonly ChatMsg[],
  query: string,
  handoffChars = 4_000,
): string {
  const findings: string[] = [];
  for (let i = history.length - 1; i >= 0 && findings.length < FINDINGS_MAX; i--) {
    const m = history[i];
    if (m.role === "assistant" && m.content.trim().length > FINDINGS_MIN_CHARS) {
      findings.push(m.content.trim());
    }
  }
  // v5 parity (audit C4): the next-step hint scans NEWEST-first; the join below is chronological.
  const next = findings.find((f) => NEXT_STEP_RE.test(f)) ?? DEFAULT_NEXT_STEP;
  findings.reverse();
  const states: string[] = [];
  for (let i = history.length - 1; i >= 0 && states.length < STATE_MAX; i--) {
    const m = history[i];
    if (m.role === "user" && m.content.includes(STATE_NEEDLE)) {
      states.push(m.content.trim());
    }
  }
  states.reverse();

  const querySlice = query.slice(0, QUERY_CHARS);
  const queryBlock = truncateMid(querySlice, Math.floor(handoffChars * 0.3));
  const findingsBlock = truncateMid(findings.join("\n\n"), Math.floor(handoffChars * 0.35));
  const stateBlock = truncateMid(states.join("\n\n"), Math.floor(handoffChars * 0.35));

  return HANDOFF_TEMPLATE
    .replace("{query}", queryBlock)
    .replace("{findings}", findingsBlock)
    .replace("{state}", stateBlock)
    .replace("{next}", next);
}

/** The full continuation prompt: `[continuation n]` header + distilled handoff. */
export function continuationPrompt(n: number, handoff: string): string {
  return `[continuation ${n}]\n${handoff}`;
}
