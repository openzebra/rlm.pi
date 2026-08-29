/** Small presentation helpers shared by the RLM widgets (glyphs, spinner, formatting). */

export const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

export function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] ?? "⠋";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** `190.2k↑ 18.6k↓ tok` — the in/out split. Falls back to plain when out is zero. */
export function formatTokensSplit(tokensIn: number, tokensOut: number): string {
  if (tokensOut > 0) return `${formatTokens(tokensIn)}↑ ${formatTokens(tokensOut)}↓ tok`;
  return `${formatTokens(tokensIn)} tok`;
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
