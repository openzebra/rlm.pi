/** Small presentation helpers shared by the RLM widgets (glyphs, spinner, formatting). */

import type { SubcallKind, SubcallStatus } from "../tool/rlm-details.ts";

export const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

export function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] ?? "⠋";
}

/** Glyph for a node's status. */
export function statusGlyph(status: SubcallStatus): string {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return spinnerFrame();
}

/** Short role label for a node kind. */
export function kindLabel(kind: SubcallKind): string {
  switch (kind) {
    case "root":
      return "RLM ▸ root";
    case "rlm":
      return "rlm_query";
    case "batch":
      return "llm_query×";
    case "tool":
      return "tool";
    default:
      return "llm_query";
  }
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
