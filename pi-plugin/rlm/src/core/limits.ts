/**
 * LimitGuard — wall-clock, token, and consecutive-error caps for a headless RLM run
 * (ported from rlm/core/rlm.py `_check_timeout` / `_check_iteration_limits`). Any breach throws
 * a LimitError; the engine catches it and returns the best partial answer it has.
 *
 * Cost is tracked for reporting only — there is no USD spend ceiling.
 */

import type { Usage } from "@earendil-works/pi-ai";

export interface Limits {
  readonly maxTimeoutMs?: number;
  readonly maxTokens?: number;
  readonly maxErrors?: number;
}

/** Pick the limit caps out of a config (`RlmConfig` satisfies this structurally). */
export function limitsFromConfig(config: Limits): Limits {
  return {
    maxTimeoutMs: config.maxTimeoutMs,
    maxTokens: config.maxTokens,
    maxErrors: config.maxErrors,
  };
}

/** Point-in-time totals for a run. */
export interface UsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

export class LimitError extends Error {
  constructor(
    public readonly kind: "timeout" | "tokens" | "errors",
    message: string,
  ) {
    super(message);
    this.name = "LimitError";
  }
}

export class LimitGuard {
  private start: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private consecutiveErrors = 0;

  constructor(private readonly limits: Limits = {}, seedElapsedMs = 0) {
    this.start = Date.now() - Math.max(0, seedElapsedMs); // C2: seed clock, clamp to prevent negative seed extending timeout budget
  }

  /** Call before each turn. */
  checkTimeout(): void {
    const { maxTimeoutMs } = this.limits;
    if (maxTimeoutMs && Date.now() - this.start > maxTimeoutMs) {
      throw new LimitError("timeout", `exceeded ${maxTimeoutMs}ms wall-clock limit`);
    }
  }

  /** Fold a completion's usage into the running totals. */
  addUsage(usage: Usage): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.costUsd += usage.cost.total;
  }

  /** Fold a recursive child run's total cost/tokens into this guard. */
  addRaw(costUsd: number, inputTokens: number, outputTokens: number): void {
    this.costUsd += costUsd;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  /** Call after each turn with whether the turn's REPL produced an error. */
  observe(hadError: boolean): void {
    this.consecutiveErrors = hadError ? this.consecutiveErrors + 1 : 0;
    const { maxErrors, maxTokens } = this.limits;
    if (maxErrors && this.consecutiveErrors >= maxErrors) {
      throw new LimitError("errors", `${this.consecutiveErrors} consecutive errors (limit ${maxErrors})`);
    }
    if (maxTokens && this.inputTokens + this.outputTokens > maxTokens) {
      throw new LimitError("tokens", `${this.inputTokens + this.outputTokens} tokens (limit ${maxTokens})`);
    }
  }

  usage(): UsageSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      durationMs: Date.now() - this.start,
    };
  }

  remainingTimeoutMs(): number | undefined {
    return this.limits.maxTimeoutMs === undefined ? undefined : this.limits.maxTimeoutMs - (Date.now() - this.start);
  }
}
