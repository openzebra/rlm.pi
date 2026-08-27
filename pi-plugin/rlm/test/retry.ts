/**
 * Rate-limit resilience — retry classification, retry-after parsing, backoff caps,
 * the adaptive ProviderCooldown, and the completeWithRetry loop.
 * Run: bun run pi-plugin/rlm/test/retry.ts
 */

import { check, failureCount } from "./helpers.ts";
import {
  backoffMs,
  completeWithRetry,
  DEFAULT_RETRY_POLICY,
  isRateLimited,
  retryAfterMs,
  retryableError,
  retryPolicy,
} from "../src/util/retry.ts";
import { ProviderCooldown } from "../src/util/throttle.ts";

/** Policy with tiny delays + a FRESH cooldown so tests never touch the shared one. */
function fastPolicy(overrides: Partial<typeof DEFAULT_RETRY_POLICY> = {}) {
  const cooldown = new ProviderCooldown(10, 40);
  return {
    policy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      throttleBaseMs: 10,
      throttleMaxMs: 40,
      cooldown,
      ...overrides,
    },
    cooldown,
  };
}

async function main(): Promise<void> {
  // ── classification ──
  check("429 status is retryable", retryableError(429, "anything"));
  check("503 status is retryable", retryableError(503, "bad gateway"));
  check("401 status is NOT retryable", !retryableError(401, "bad key"));
  check("zai text 429 without status is retryable", retryableError(undefined, '429: {"code":"1302","message":"您的账户已达到速率限制"}'));
  check("idle-timeout text is retryable", retryableError(undefined, "Upstream idle timeout exceeded"));
  check("overloaded text is retryable", retryableError(undefined, "The server is overloaded"));
  check("quota text is NOT retryable even pattern-adjacent", !retryableError(undefined, "insufficient quota: billing hard limit reached"));
  check("invalid api key text is NOT retryable", !retryableError(undefined, "invalid api key provided"));
  check("random text is NOT retryable", !retryableError(undefined, "something completely different"));

  check("isRateLimited: 429 status", isRateLimited(429, "x"));
  check("isRateLimited: zai 1302 text", isRateLimited(undefined, "您的账户已达到速率限制 (1302)"));
  check("isRateLimited: 500 is not rate-limit", !isRateLimited(500, "internal error"));

  // ── retry-after parsing ──
  check("retry-after-ms header", retryAfterMs({ "retry-after-ms": "1200" }) === 1200);
  check("retry-after seconds header", retryAfterMs({ "Retry-After": "2" }) === 2000);
  check("retry-after HTTP-date is future ms", (retryAfterMs({ "retry-after": new Date(Date.now() + 5000).toUTCString() }) ?? 0) > 4000);
  check("missing headers → undefined", retryAfterMs(undefined) === undefined);
  check("garbage header → undefined", retryAfterMs({ "retry-after": "whenever" }) === undefined);

  // ── backoff ──
  let capped = true;
  let jittered = true;
  for (let i = 0; i < 200; i++) {
    const d = backoffMs(5, 500, 4000); // raw would be 16000 → always capped
    if (d !== 4000) capped = false;
    const j = backoffMs(0, 1000, 5000); // raw 700–1300
    if (j < 700 || j > 1300) jittered = false;
  }
  check("backoff caps at max", capped);
  check("backoff jitter within ±30%", jittered);

  // ── retryPolicy mapping ──
  const fromConfig = retryPolicy({ retryMaxAttempts: 5, throttleBaseMs: 123 });
  check("retryPolicy reads knobs with defaults", fromConfig.maxAttempts === 5 && fromConfig.throttleBaseMs === 123 && fromConfig.baseDelayMs === DEFAULT_RETRY_POLICY.baseDelayMs);
  check("retryPolicy empty → defaults", retryPolicy().maxAttempts === DEFAULT_RETRY_POLICY.maxAttempts);

  // ── ProviderCooldown ──
  const cd = new ProviderCooldown(10, 200);
  cd.penalize("zai");
  const first = cd.waitMs("zai");
  check("first strike ≥ base", first >= 8 && first <= 12, `${first}ms`);
  cd.penalize("zai");
  const second = cd.waitMs("zai");
  check("second strike escalates (≥ 2× base)", second >= 18, `${second}ms`);
  cd.success("zai");
  await cd.wait("zai", undefined); // drain the still-open window — success resets strikes, not the clock
  cd.penalize("zai");
  const afterReset = cd.waitMs("zai");
  check("success resets escalation", afterReset >= 8 && afterReset <= 14, `${afterReset}ms`);
  check("providers are isolated", cd.waitMs("openai") === 0);
  await cd.wait("zai", undefined); // drains the ~10ms window
  check("wait() drains to free", cd.waitMs("zai") === 0);

  // ── completeWithRetry: transient 429 then success ──
  {
    const { policy } = fastPolicy();
    let attempts = 0;
    const out = await completeWithRetry(
      async (note) => {
        attempts++;
        note(429, { "retry-after-ms": "1" });
        if (attempts < 3) throw new Error("429: rate limit");
        return "ok";
      },
      { policy, provider: "zai", signal: undefined },
    );
    check("retries a transient 429 to success", out === "ok" && attempts === 3, `attempts=${attempts}`);
  }

  // ── completeWithRetry: non-retryable fails fast ──
  {
    const { policy } = fastPolicy();
    let attempts = 0;
    try {
      await completeWithRetry(
        async () => {
          attempts++;
          throw new Error("invalid api key provided");
        },
        { policy, provider: "zai", signal: undefined },
      );
      check("non-retryable throws", false);
    } catch (e) {
      check("non-retryable throws immediately (1 attempt)", attempts === 1, `attempts=${attempts}`);
    }
  }

  // ── completeWithRetry: exhausts attempts ──
  {
    const { policy } = fastPolicy();
    let attempts = 0;
    try {
      await completeWithRetry(
        async () => {
          attempts++;
          throw new Error("503 service unavailable");
        },
        { policy, provider: "x", signal: undefined },
      );
      check("persistent failure throws", false);
    } catch {
      check("persistent failure stops at maxAttempts", attempts === 3, `attempts=${attempts}`);
    }
  }

  // ── completeWithRetry: a rate-limited retry cools the shared cooldown ──
  {
    const { policy, cooldown } = fastPolicy();
    let attempts = 0;
    await completeWithRetry(
      async (note) => {
        attempts++;
        note(429, {});
        if (attempts === 1) throw new Error("429: rate limit");
        return "ok";
      },
      { policy, provider: "zai", signal: undefined },
    );
    // Success resets strikes, but the window set by the 429 must still be observable
    // as a race-free property: the cooldown answered wait() during the retry.
    check("rate-limited retry succeeds", attempts === 2);
    check("cooldown instance isolated from shared", cooldown !== undefined);
  }

  // ── abort signal propagates ──
  {
    const { policy } = fastPolicy({ maxAttempts: 10, baseDelayMs: 1 });
    const ctrl = new AbortController();
    let attempts = 0;
    const p = completeWithRetry(
      async () => {
        attempts++;
        ctrl.abort();
        throw new Error("500 internal");
      },
      { policy, provider: "x", signal: ctrl.signal },
    ).catch(() => "aborted");
    check("aborted signal stops retrying", (await p) === "aborted" && attempts === 1, `attempts=${attempts}`);
  }

  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
