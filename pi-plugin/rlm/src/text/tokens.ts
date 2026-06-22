/**
 * Lightweight, dependency-free token estimation.
 *
 * We deliberately avoid a tokenizer dependency: RLM only needs rough budgets to decide when
 * to chunk or compact, and a ~4-chars/token heuristic is accurate enough for that. Real token
 * accounting comes back from the provider in `usage` after each call.
 */

const CHARS_PER_TOKEN = 4;

/** Rough token count for a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough token count for a list of role/content messages. */
export function estimateMessageTokens(messages: { content: string }[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length + 8; // small per-message overhead
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Total character length of a context payload (string or list of strings). */
export function contextLength(context: unknown): number {
  if (typeof context === "string") return context.length;
  if (Array.isArray(context)) return context.reduce<number>((n, x) => n + String(x).length, 0);
  return JSON.stringify(context ?? "").length;
}

/** Human label for a context payload's type, used in the metadata prompt. */
export function contextTypeLabel(context: unknown): string {
  if (typeof context === "string") return "str";
  if (Array.isArray(context)) return `list[${context.length}]`;
  return typeof context;
}
