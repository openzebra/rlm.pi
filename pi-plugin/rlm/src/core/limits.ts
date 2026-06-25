/**
 * LimitGuard — wall-clock, token, cost, and consecutive-error caps for a headless RLM run
 * (ported from rlm/core/rlm.py `_check_timeout` / `_check_iteration_limits`). Any breach throws
 * a LimitError; the engine catches it and returns the best partial answer it has.
 */

import type { Usage } from "@earendil-works/pi-ai";

export interface Limits {
  maxTimeoutMs?: number;
  maxTokens?: number;
  maxBudgetUsd?: number;
  maxErrors?: number;
}

export class LimitError extends Error {
  constructor(
    public readonly kind: "timeout" | "tokens" | "budget" | "errors",
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
    const { maxErrors, maxTokens, maxBudgetUsd } = this.limits;
    if (maxErrors && this.consecutiveErrors >= maxErrors) {
      throw new LimitError("errors", `${this.consecutiveErrors} consecutive errors (limit ${maxErrors})`);
    }
    if (maxTokens && this.inputTokens + this.outputTokens > maxTokens) {
      throw new LimitError("tokens", `${this.inputTokens + this.outputTokens} tokens (limit ${maxTokens})`);
    }
    if (maxBudgetUsd && this.costUsd > maxBudgetUsd) {
      throw new LimitError("budget", `$${this.costUsd.toFixed(4)} spent (limit $${maxBudgetUsd})`);
    }
  }

  usage() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      durationMs: Date.now() - this.start,
    };
  }

  remainingBudgetUsd(): number | undefined {
    return this.limits.maxBudgetUsd === undefined ? undefined : this.limits.maxBudgetUsd - this.costUsd;
  }

  remainingTimeoutMs(): number | undefined {
    return this.limits.maxTimeoutMs === undefined ? undefined : this.limits.maxTimeoutMs - (Date.now() - this.start);
  }
}
