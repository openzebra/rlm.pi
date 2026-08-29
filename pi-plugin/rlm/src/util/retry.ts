/**
 * Retry + rate-limit classification for LLM completions — the retry half of resilience.
 *
 * pi-ai surfaces provider failures as `stopReason:"error"` plus an errorMessage STRING
 * (the HTTP status baked into the text, e.g. `429: {"code":"1302",...}`), but its
 * `onResponse` hook still hands us the raw `{status, headers}` of every HTTP response.
 * Classification therefore runs on both: captured status first, text patterns as the
 * fallback — the same shape pi-ai's own codex provider uses internally. Timing, when the
 * provider sends it, comes from `retry-after` / `retry-after-ms` headers (numeric seconds,
 * milliseconds, or an HTTP-date); otherwise exponential backoff with jitter, capped.
 *
 * Rate-limit errors additionally penalize the per-provider cooldown (util/throttle.ts):
 * the retry sleeps, and every OTHER request queued behind the same provider waits too.
 */

import { ProviderCooldown, sleepMs, sharedCooldown } from "./throttle.ts";

// Auth/quota failures must not be retried — they burn attempts and never recover.
const NON_RETRYABLE_TEXT =
  /api[ -]?key|unauthorized|forbidden|permission denied|billing|insufficient|balance|quota exceeded|not.?found|context length|too large|invalid request|malformed|content.?filter/i;
// Transport/server transients — worth another attempt. "Provider finish_reason: error" is the
// generic shape OpenRouter relays when the UPSTREAM kills a generation mid-stream (observed
// from Cohere's free pool: native_finish_reason "error", no message, no code, partial usage) —
// HTTP 200, so it is inherently transient-by-nature and must be retried.
const RETRYABLE_TEXT =
  /\b429\b|rate.?limit|overloaded|service.?unavailable|upstream|timeout|timed.?out|temporarily|try.?again|econnreset|econnrefused|etimedout|socket hang up|network|finish.?reason: ?(error|network_error)|1302|速率|频率/i;
const RATE_LIMIT_TEXT = /\b429\b|rate.?limit|1302|速率|频率/i;

const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 413, 422]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Did this failure mean "too many requests"? Drives the cooldown penalty. */
export function isRateLimited(status: number | undefined, text: string): boolean {
  return status === 429 || (status === undefined && RATE_LIMIT_TEXT.test(text));
}

/** Should this failure get another attempt? Explicit non-retryables win over patterns. */
export function retryableError(status: number | undefined, text: string): boolean {
  if (status !== undefined) {
    if (NON_RETRYABLE_STATUS.has(status)) return false;
    if (RETRYABLE_STATUS.has(status)) return true;
  }
  if (NON_RETRYABLE_TEXT.test(text)) return false;
  return RETRYABLE_TEXT.test(text);
}

/** Header lookup that tolerates any key casing the provider layer kept. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/** Parse `retry-after` / `retry-after-ms` into ms; undefined when absent or garbage. */
export function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const ms = header(headers, "retry-after-ms");
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = header(headers, "retry-after");
  if (ra === undefined) return undefined;
  const seconds = Number(ra);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Exponential backoff with ±30% jitter, hard-capped at `maxMs`. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const raw = baseMs * 2 ** attempt * (0.7 + Math.random() * 0.6);
  return Math.min(Math.round(raw), maxMs);
}

/** Numbers knobs — mirrors the optional RlmConfig fields (core/types.ts). */
export interface RetryPolicy {
  /** TOTAL attempts per call, including the first. 1 = never retry. */
  readonly maxAttempts: number;
  /** Separate, GENEROUS budget for rate limits only: a 429 means "come back later",
   *  not "fail" — the call keeps parking on the cooldown window instead of dying.
   *  Burned only by rate-limited failures, never by 5xx/timeouts. */
  readonly rateLimitMaxAttempts: number;
  readonly baseDelayMs: number;
  /** Cap for any single retry delay, including a parsed `retry-after`. */
  readonly maxDelayMs: number;
  /** First cooldown when a provider 429s without timing; doubles per consecutive strike. */
  readonly throttleBaseMs: number;
  /** Ceiling for the adaptive per-provider cooldown. */
  readonly throttleMaxMs: number;
  /** Isolation for tests; defaults to the process-wide shared cooldown. */
  readonly cooldown?: ProviderCooldown;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  rateLimitMaxAttempts: 8,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  throttleBaseMs: 2_000,
  throttleMaxMs: 60_000,
});

/** Shape of the optional retry knobs on RlmConfig — kept structural to avoid a cycle. */
export interface RetryConfigNumbers {
  readonly retryMaxAttempts?: number;
  readonly rateLimitMaxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly throttleBaseMs?: number;
  readonly throttleMaxMs?: number;
}

/** Derive a policy from persisted config knobs, falling back to the defaults. */
export function retryPolicy(from: RetryConfigNumbers = {}): RetryPolicy {
  return {
    maxAttempts: from.retryMaxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    rateLimitMaxAttempts: from.rateLimitMaxAttempts ?? DEFAULT_RETRY_POLICY.rateLimitMaxAttempts,
    baseDelayMs: from.retryBaseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: from.retryMaxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    throttleBaseMs: from.throttleBaseMs ?? DEFAULT_RETRY_POLICY.throttleBaseMs,
    throttleMaxMs: from.throttleMaxMs ?? DEFAULT_RETRY_POLICY.throttleMaxMs,
  };
}

/**
 * Run `attempt` under the policy. `note` is how the caller feeds captured HTTP
 * `{status, headers}` back (pi-ai's onResponse hook) — cleared before every attempt so a
 * stale capture never misclassifies a fresh failure. Rate-limit failures park on the
 * cooldown — their own, generous budget — so sibling requests slow down with us;
 * `onPark`/`onRelease` surface the parking to the UI as a "queued" phase.
 */
export async function completeWithRetry<T>(
  attempt: (note: (status: number, headers: Record<string, string>) => void) => Promise<T>,
  opts: {
    readonly policy: RetryPolicy;
    readonly provider: string;
    readonly signal?: AbortSignal;
    readonly onPark?: (ms: number) => void;
    readonly onRelease?: () => void;
  },
): Promise<T> {
  const { policy, provider, signal, onPark, onRelease } = opts;
  const cooldown = policy.cooldown ?? sharedCooldown;
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  const note = (s: number, h: Record<string, string>): void => {
    status = s;
    headers = h;
  };
  let rlTries = 0; // rate-limit failures burn their OWN budget, never maxAttempts
  for (let tries = 0; ; tries++) {
    await cooldown.wait(provider, signal, onPark, onRelease);
    status = undefined;
    headers = undefined;
    try {
      const out = await attempt(note);
      cooldown.success(provider);
      return out;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) throw err;
      if (isRateLimited(status, msg)) {
        // "Come back later" — park on the shared cooldown instead of dying. The strike
        // heuristic escalates the window; the wait itself happens at the loop top, so
        // sibling requests behind the same provider slow down together.
        if (rlTries + 1 >= policy.rateLimitMaxAttempts) throw err;
        rlTries++;
        const hint = retryAfterMs(headers);
        cooldown.penalize(provider, hint !== undefined ? Math.min(hint, policy.throttleMaxMs) : undefined);
        continue;
      }
      if (tries + 1 >= policy.maxAttempts) throw err;
      if (!retryableError(status, msg)) throw err;
      await sleepMs(
        Math.min(retryAfterMs(headers) ?? backoffMs(tries, policy.baseDelayMs, policy.maxDelayMs), policy.maxDelayMs),
        signal,
      );
    }
  }
}
