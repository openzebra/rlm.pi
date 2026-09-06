/**
 * Host-side Okapi BM25 (Workstreams C/D/E ranking).
 *
 * BM25 DUALITY, documented not accidental: this file and `sandbox/py/retrieval.py`
 * (`_Bm25Index`) implement the SAME scoring for two runtimes — identical constants, identical
 * tokenizer, identical idf/norm formulas — so a note ranked here lands in the same order the
 * sandbox-side `search` would put it. Keep the two files in lockstep (AGENTS.md convention).
 */

const BM25_K1 = 1.2; // mirrors retrieval.py:_BM25_K1
const BM25_B = 0.75; // mirrors retrieval.py:_BM25_B
// Mirrors retrieval.py:_TOKEN_SPLIT / _CAMEL_SPLIT: lowercased alphanumeric runs plus
// camelCase parts, so `resolveModelId`-style identifiers match their prose spellings.
const TOKEN_SPLIT = /[^0-9A-Za-z]+/;
const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])/;

export function bm25Tokenize(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.split(TOKEN_SPLIT)) {
    if (raw === "") continue;
    const lowered = raw.toLowerCase();
    out.push(lowered);
    if (raw.length > 3) {
      const parts = raw.split(CAMEL_SPLIT);
      if (parts.length > 1) {
        for (const part of parts) {
          const piece = part.toLowerCase();
          if (piece !== "" && piece !== lowered) out.push(piece);
        }
      }
    }
  }
  return out;
}

export interface Bm25Entry<T> {
  readonly item: T;
  readonly text: string;
}

export interface Bm25Hit<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Rank entries against a query, best first, top-k, score > 0 only.
 * Pre-allocated score/index arrays; no growth in the scoring loops.
 */
export function bm25Rank<T>(
  query: string,
  entries: readonly Bm25Entry<T>[],
  k: number,
): readonly Bm25Hit<T>[] {
  const n = entries.length;
  if (n === 0 || k <= 0) return [];
  const docLens = new Array<number>(n);
  const postings = new Map<string, Array<readonly [number, number]>>();
  for (let i = 0; i < n; i++) {
    const terms = bm25Tokenize(entries[i].text);
    docLens[i] = terms.length;
    const freq = new Map<string, number>();
    for (const term of terms) freq.set(term, (freq.get(term) ?? 0) + 1);
    for (const [term, tf] of freq) {
      const list = postings.get(term);
      if (list !== undefined) list.push([i, tf]);
      else postings.set(term, [[i, tf]]);
    }
  }
  let totalLen = 0;
  for (let i = 0; i < n; i++) totalLen += docLens[i];
  const avgLen = totalLen > 0 ? totalLen / n : 1.0;

  const scores = new Array<number>(n).fill(0);
  const seen = new Set<string>();
  for (const term of bm25Tokenize(query)) {
    if (seen.has(term)) continue; // Python twin scores set(terms)
    seen.add(term);
    const posting = postings.get(term);
    if (posting === undefined) continue;
    const df = posting.length;
    const idf = Math.log(1.0 + (n - df + 0.5) / (df + 0.5));
    for (const [idx, tf] of posting) {
      const norm = BM25_K1 * (1.0 - BM25_B + BM25_B * (docLens[idx] / avgLen));
      scores[idx] += (idf * (tf * (BM25_K1 + 1.0))) / (tf + norm);
    }
  }

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a] || a - b); // deterministic tie-break
  const out: Bm25Hit<T>[] = [];
  for (let i = 0; i < n && out.length < k; i++) {
    const idx = order[i];
    if (scores[idx] > 0) out.push({ item: entries[idx].item, score: scores[idx] });
  }
  return out;
}
