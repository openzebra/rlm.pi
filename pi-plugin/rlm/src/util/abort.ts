/**
 * abort — combine abort signals without leaking listeners.
 *
 * pi hands every tool execution a per-call signal (esc) while the session adds
 * longer-lived controllers (/rlm-stop rotation) — in-flight work must react to both.
 * The longer-lived signal outlives any single call, so its relay listener MUST detach
 * when the awaited work settles, or every call accumulates one listener forever.
 */

export interface RacedSignal {
  /** Fires when either input aborts; undefined when no input signal was given. */
  readonly signal: AbortSignal | undefined;
  /** Detach relay listeners — call when the awaited work settles. */
  dispose(): void;
}

export function raceAbort(a: AbortSignal | undefined, b: AbortSignal | undefined): RacedSignal {
  if (a === undefined || b === undefined) return { signal: a ?? b, dispose: () => {} };
  const combined = new AbortController();
  const relay = (src: AbortSignal): (() => void) => () => combined.abort(src.reason);
  const onA = relay(a);
  const onB = relay(b);
  if (a.aborted) combined.abort(a.reason);
  if (b.aborted) combined.abort(b.reason);
  a.addEventListener("abort", onA);
  b.addEventListener("abort", onB);
  return {
    signal: combined.signal,
    dispose: () => {
      a.removeEventListener("abort", onA);
      b.removeEventListener("abort", onB);
    },
  };
}
