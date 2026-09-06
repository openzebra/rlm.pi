/**
 * Token budget cascade (port of the v4/v5 `budget.py` engine).
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
import type { RunState } from "./run-state.ts";
import { compactJSON } from "./run-state.ts";

interface TokenBudgetOptions {
  readonly softFrac?: number;
  readonly continuations?: number;
  readonly maxContinuations?: number;
}

type BudgetState = "" | "soft" | "hard";

/** v5 verbatim: the soft wrap-up note prepended to the single turn after crossing soft. */
export const WRAP_UP_BUDGET: string =
  "[budget] ~80% of your token cap — ONE turn left. If the task is answerable NOW, finalize " +
    '(set answer["ready"] = True). Otherwise print a compact findings dump: what is confirmed, ' +
    "current file/line or search position, and the exact next step — a fresh continuation picks " +
    "it up. Do not start new exploration.";

export const DEFAULT_NEXT_STEP: string =
  "continue the probing that was in flight, then finalize";

/** v5 verbatim template (adapting the finalize spelling to this plugin's REPL). */
const HANDOFF_TEMPLATE: string =
  "A prior RLM run hit its token cap mid-task.\n" +
    "You are its continuation — pick up EXACTLY where it stopped.\n\n" +
    "ORIGINAL TASK:\n{query}\n\n" +
    "CONFIRMED FINDINGS SO FAR:\n{findings}\n\n" +
    "CURRENT STATE / LAST ACTIONS:\n{state}\n\n" +
    "NEXT STEP: {next}\n" +
    "Do not re-do confirmed work; continue from the NEXT STEP and finalize as\n" +
    'soon as the task is answerable (answer["ready"] = True).';

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
/**
 * Minimum context window (tokens) for the token-budget cascade to engage at all.
 *
 * The formula (window × budgetShare) assumes the window is large enough that a fraction of it
 * is a meaningful working budget. Below this floor the derived cap shrinks below a task's FIXED
 * overhead (system prompt + per-turn history re-send + sub-LLM calls) and strangles the run —
 * a 32k window would cap a task at 8k tokens, less than the protocol scaffolding alone.
 * So for smaller windows the rule does not apply: the budget is effectively unbounded and runs
 * stay bounded by maxIterations / maxErrors / wall-clock instead.
 */
export const BUDGET_WINDOW_FLOOR = 250_000;

/** One TokenBudget construction shape — the cap varies, the policy knobs never do (DRY). */
function makeBudget(config: RlmConfig, cap: number): TokenBudget {
  return new TokenBudget(cap, {
    softFrac: config.budgetSoftFrac,
    maxContinuations: config.budgetMaxContinuations,
  });
}

/** An effective budget that can never trigger — the cascade "switched off" without changing
 *  any call-site types (budget: TokenBudget | undefined). */
function unboundedBudget(config: RlmConfig): TokenBudget {
  return makeBudget(config, Number.MAX_SAFE_INTEGER);
}

export function resolveBudget(contextWindow: number | undefined, config: RlmConfig): TokenBudget {
  const ctx = contextWindow !== undefined && contextWindow > 0 ? contextWindow : 32_000;
  if (ctx < BUDGET_WINDOW_FLOOR) return unboundedBudget(config);
  const shareCap = Math.floor(ctx * config.budgetShare);
  const cap = config.budgetTaskCap > 0 ? Math.min(shareCap, config.budgetTaskCap) : shareCap;
  return makeBudget(config, Math.max(cap, 1));
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

/** Digest/handoff section caps — ONE source: budget.ts's handoff distillation and the root
 *  digest (core/root-digest.ts) must never drift apart on the same trajectory heuristics. */
export const FINDINGS_MAX = 6;
export const FINDINGS_MIN_CHARS = 20;
export const STATE_MAX = 8;
const QUERY_CHARS = 800;
const STATE_NEEDLE = "REPL stdout";
/** Next-step probe shared by the engine handoff and the root digest (one wording source). */
export const NEXT_STEP_RE = /next|then|will |todo/i;

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

// ── Workstream A: state-shaped hard-budget handoff ─────────────────────────────────

/**
 * With Σ active, the hard-budget handoff IS the execution state: compactJSON(Σ) replaces the
 * prose walk — smaller and lossless where it matters (findings/verifiedFacts survive
 * verbatim; the paper's exact-state > prose-summary result, Tables 1/5). Reuses the v5
 * HANDOFF_TEMPLATE slots; `distillTrajectory` remains only for degraded runs.
 */
export function stateHandoff(state: RunState, query: string, handoffChars = 4_000): string {
  const findingsBlock = state.findings.slice(-3).join("\n");
  return HANDOFF_TEMPLATE.replace("{query}", truncateMid(query.slice(0, QUERY_CHARS), Math.floor(handoffChars * 0.3)))
    .replace("{findings}", truncateMid(findingsBlock, Math.floor(handoffChars * 0.2)))
    .replace("{state}", truncateMid(compactJSON(state), Math.floor(handoffChars * 0.35)))
    .replace("{next}", state.nextStep !== "" ? state.nextStep : DEFAULT_NEXT_STEP);
}

// ── Workstream F: rectification at budget hard-state (MAS2 Eq. 5, local tier) ─────────

/** One deterministic local fix for a continuation — discriminated union, no flags.
 *  DOCTRINE: no arm ever switches models or providers — a failing model retries on itself
 *  until the attempt budget is exhausted, then fails loudly. */
export type RectifyAction =
  | { readonly kind: "narrow-paths"; readonly paths: readonly string[] }
  | { readonly kind: "reduce-concurrency"; readonly maxConcurrentSubcalls: number }
  | { readonly kind: "none"; readonly reason: string };

/** Compact telemetry label for a rectification (run-node detail line). */
export function rectifyLabel(action: RectifyAction): string {
  switch (action.kind) {
    case "narrow-paths":
      return `narrow-paths (${action.paths.length})`;
    case "reduce-concurrency":
      return `reduce-concurrency → ${action.maxConcurrentSubcalls}`;
    case "none":
      return "none";
  }
}

/** Path-like tokens harvested from Σ — must contain a separator and an extension. */
const STATE_PATH_TOKEN = /(?:[\w@.-]+\/+)+[\w@.-]+\.[A-Za-z]{1,6}/g;

/** Top repeated paths from Σ, deterministic: frequency desc, then lexicographic; ≤4. */
function topPathsFromState(state: RunState | undefined): readonly string[] {
  if (state === undefined) return [];
  const freq = new Map<string, number>();
  const sources = [...state.verifiedFacts, ...state.findings];
  for (const line of sources) {
    for (const match of line.matchAll(STATE_PATH_TOKEN)) {
      const path = match[0];
      freq.set(path, (freq.get(path) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([path]) => path);
}

/**
 * MAS2 rectification (Eq. 5 adapted): at a budget hard-state, sample ONE local fix — no LLM.
 * Deterministic priority: (1) narrow child paths from the run's top Σ paths, (2) halve leaf
 * admission, (3) none. The model/provider pair is NEVER a rectification axis: a failing
 * model retries until its attempt budget is exhausted and then the call fails loudly —
 * no silent fallback, no swapping. The engine applies the choice to the continuation
 * invocation and logs it on the run node.
 */
export function rectify(args: {
  readonly state?: RunState;
  readonly config: RlmConfig;
}): RectifyAction {
  const paths = topPathsFromState(args.state);
  if (paths.length >= 2) return { kind: "narrow-paths", paths };
  if (args.config.maxConcurrentSubcalls >= 4) {
    return {
      kind: "reduce-concurrency",
      maxConcurrentSubcalls: Math.max(1, Math.floor(args.config.maxConcurrentSubcalls / 2)),
    };
  }
  return { kind: "none", reason: "no local fix available" };
}
