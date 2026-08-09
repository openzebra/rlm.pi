/**
 * Lightweight, dependency-free token estimation.
 *
 * We deliberately avoid a tokenizer dependency: RLM only needs rough budgets to decide when
 * to chunk or compact, and a ~4-chars/token heuristic is accurate enough for that. Real token
 * accounting comes back from the provider in `usage` after each call.
 */

const CHARS_PER_TOKEN = 4;

/** Rough token count for a character length (≈4 chars/token). Always ≥ 1 for non-empty text. */
export function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/** Rough token count for a list of role/content messages. */
export function estimateMessageTokens(messages: { content: string }[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length + 8; // small per-message overhead
  return estimateTokens(chars);
}

/**
 * Character length of one context entry. `ContextFile`-shaped entries report their content
 * length; anything else falls back to its serialized form.
 *
 * Deliberately does NOT import `isContextFile` from context/namespace.ts: that module
 * imports `estimateTokens` from here, so the reverse import would be a cycle. `in`-narrowing
 * needs no type guard and no cast.
 */
function entryLength(entry: unknown): number {
  if (typeof entry === "string") return entry.length;
  if (entry !== null && typeof entry === "object" && "content" in entry) {
    const content: unknown = entry.content;
    if (typeof content === "string") return content.length;
  }
  return JSON.stringify(entry ?? "").length;
}

/**
 * Total character length of a context payload (string, file bundle, or arbitrary value).
 *
 * The array branch must read each entry's `content`: `String(fileEntry)` yields
 * "[object Object]" (15 chars), which under-reported a packed repository by ~200x. This number
 * is what buildMetadataLine tells the model to size its batches against, and it is replayed
 * into the system prompt, so it has to be real.
 */
export function contextLength(context: unknown): number {
  if (typeof context === "string") return context.length;
  if (!Array.isArray(context)) return JSON.stringify(context ?? "").length;
  let total = 0; // running sum — no intermediate array, no per-entry closure
  for (let i = 0; i < context.length; i++) total += entryLength(context[i]);
  return total;
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
 *  Handles both a flat ContextFile[] and a raw bundle object ({ files: [...] }) so callers
 *  don't need to know which form they received. */
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
