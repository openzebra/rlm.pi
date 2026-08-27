/**
 * Per-provider adaptive cooldown — the throttle half of rate-limit resilience.
 *
 * A 429 means the provider wants FEWER requests for a while, not just this one retried.
 * `ProviderCooldown` holds each provider's admission time: `wait()` parks new requests
 * until the window opens; `penalize()` extends it, escalating on consecutive strikes
 * (base × 2^strikes, capped) so a persistent limit backs the whole fan-out off
 * exponentially. Any success clears the strike counter — providers rarely announce
 * recovery, so we probe again at full concurrency rather than assume the worst.
 *
 * `sharedCooldown` is process-wide on purpose: the provider's limit is process-wide.
 * Tests inject a fresh instance via `RetryPolicy.cooldown` for isolation.
 */

/** Abort-aware sleep. Rejects with "aborted" the moment `signal` fires. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout((): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ProviderCooldown {
  private readonly blockedUntil = new Map<string, number>();
  private readonly strikes = new Map<string, number>();

  constructor(private readonly baseMs: number, private readonly maxMs: number) {}

  /** ms until `provider` may be admitted again; 0 = free. */
  waitMs(provider: string): number {
    return Math.max(0, (this.blockedUntil.get(provider) ?? 0) - Date.now());
  }

  /** Park until the window opens. Re-checks after every wake — penalize() may extend it. */
  async wait(provider: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const ms = this.waitMs(provider);
      if (ms <= 0) return;
      await sleepMs(ms, signal);
    }
  }

  /**
   * Extend the window. `ms` (e.g. a parsed `retry-after`) floors the penalty; the strike
   * heuristic (base × 2^strikes, capped) always applies on top so repeated 429s escalate
   * even when the provider sends no timing at all — zai's `{"code":"1302",...}` body, for
   * one, carries none.
   */
  penalize(provider: string, ms?: number): void {
    const strikes = (this.strikes.get(provider) ?? 0) + 1;
    this.strikes.set(provider, strikes);
    const heuristic = Math.min(this.baseMs * 2 ** (strikes - 1), this.maxMs);
    const until = Date.now() + Math.max(ms ?? 0, heuristic);
    const prev = this.blockedUntil.get(provider) ?? 0;
    if (until > prev) this.blockedUntil.set(provider, until);
  }

  /** A success means the window opened — reset escalation for the next burst. */
  success(provider: string): void {
    this.strikes.delete(provider);
  }
}

/** Mirrored into DEFAULT_RETRY_POLICY (util/retry.ts imports these — keep one-way). */
export const THROTTLE_DEFAULTS = Object.freeze({ baseMs: 2_000, maxMs: 60_000 } as const);

/** Process-wide instance: every completion in this pi session shares it. */
export const sharedCooldown: ProviderCooldown = new ProviderCooldown(
  THROTTLE_DEFAULTS.baseMs,
  THROTTLE_DEFAULTS.maxMs,
);
