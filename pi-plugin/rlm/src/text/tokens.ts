/**
 * Lightweight, dependency-free token estimation.
 *
 * We deliberately avoid a tokenizer dependency: RLM only needs rough budgets to decide when
 * to chunk or compact, and a ~4-chars/token heuristic is accurate enough for that. Real token
 * accounting comes back from the provider in `usage` after each call.
 */

const CHARS_PER_TOKEN = 4;

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

/** Compact per-file token distribution for a bundle context (the article's `context_lengths`). */
export interface ContextSizeStats {
  readonly files: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/** `true` if `v` is a context entry carrying an estimated `tokens` count. */
const isTokenizedEntry = (v: unknown): v is { readonly tokens: number } =>
  typeof v === "object" && v !== null && typeof (v as { readonly tokens?: unknown }).tokens === "number";

/** Per-file token distribution for a context payload; `undefined` for plain strings or empty arrays.
 *  Handles both serialized ContextFile[] (flat array from serializeForSandbox) and raw ContextBundle
 *  objects ({ files: [...] }) so callers don't need to know which form they received. */
export function contextSizeStats(context: unknown): ContextSizeStats | undefined {
  // Normalise to a flat entry list: accept either a direct array or an object with a .files array.
  const entries: readonly unknown[] = Array.isArray(context)
    ? context
    : Array.isArray((context as { readonly files?: unknown } | null)?.files)
      ? (context as { readonly files: readonly unknown[] }).files
      : [];
  if (entries.length === 0) return undefined;
  const sizes = new Array<number>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    sizes[i] = isTokenizedEntry(entry) ? entry.tokens : 0;
  }
  sizes.sort((a, b) => a - b);
  const mid = sizes.length >> 1;
  const median = sizes.length % 2 !== 0 ? sizes[mid] : Math.round((sizes[mid - 1] + sizes[mid]) / 2);
  return Object.freeze<ContextSizeStats>({ files: sizes.length, min: sizes[0], median, max: sizes[sizes.length - 1] });
}
