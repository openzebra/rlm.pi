/**
 * Host-side Okapi BM25 (Workstreams C/D/E ranking).
 *
 * BM25 DUALITY, documented not accidental: this file and `sandbox/py/retrieval.py`
 * (`_Bm25Index`) implement the SAME scoring for two runtimes — identical constants, identical
 * tokenizer + stemmer, identical idf/norm formulas, identical PRF/phrase-bonus pipeline — so a
 * note ranked here lands in the same order the sandbox-side `search` would put it. Keep the two
 * files in lockstep (AGENTS.md convention). Python-only extras (window overlap, glob
 * pre-filter, adjacent-window merge) are window mechanics, not scoring, and stop at that file.
 */

const BM25_K1 = 1.2; // mirrors retrieval.py:_BM25_K1
const BM25_B = 0.75; // mirrors retrieval.py:_BM25_B
// Mirrors retrieval.py:_TOKEN_SPLIT / _CAMEL_SPLIT: lowercased alphanumeric runs plus
// camelCase parts, so `resolveModelId`-style identifiers match their prose spellings.
const TOKEN_SPLIT = /[^0-9A-Za-z]+/;
const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])/;

// BM25 V2 constants (twin: retrieval.py — identical values there).
const PRF_FEEDBACK_DOCS = 3; // top first-pass docs harvested for expansion terms
const PRF_EXPANSION_TERMS = 8; // max terms added by pseudo-relevance feedback
const PRF_EXPANSION_WEIGHT = 0.4; // Rocchio beta: expansion terms contribute at this weight
const PRF_MIN_DOCS = 12; // below this the corpus is too small to harvest from
const PHRASE_BONUS_WEIGHT = 0.25; // per adjacent query-bigram occurrence in a doc
const RERANK_POOL_MULT = 3; // phrase-bonus pool = top (k * mult) docs, capped
const RERANK_POOL_CAP = 60;

/**
 * Light deterministic suffix stripper (TWIN: retrieval.py `_stem` — identical rules).
 * A matching aid, not linguistics: different surface forms converge (files/file → fil,
 * running/run → run, studies/study → studi); identical forms always map to themselves.
 */
function stem(t: string): string {
  if (t.length <= 3) return t;
  let r: string;
  if (t.endsWith("ies")) {
    r = t.slice(0, -3) + "i"; // studies → studi
  } else if (t.endsWith("sses")) {
    r = t.slice(0, -2); // classes → class
  } else if (t.endsWith("es")) {
    const stem2 = t.slice(0, -2);
    r = /(x|ch|sh)$/.test(stem2) ? stem2 : t.slice(0, -1); // boxes → box, files → file
  } else if (t.endsWith("s") && !/(ss|us|is)$/.test(t)) {
    r = t.length > 4 ? t.slice(0, -1) : t; // cats → cat; keeps "was"/"its"
  } else {
    r = t;
  }
  if (r.endsWith("ing") && r.length >= 6) {
    let base = r.slice(0, -3); // running → runn
    if (base.length >= 4) {
      if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
        base = base.slice(0, -1); // runn → run
      }
      r = base; // "string" stays whole
    }
  } else if (r.endsWith("ed") && r.length >= 5) {
    let base = r.slice(0, -2); // mapped → mapp
    if (base.length >= 4) {
      if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
        base = base.slice(0, -1); // mapp → map
      }
      r = base;
    }
  }
  if (r.endsWith("y") && r.length > 3) r = r.slice(0, -1) + "i"; // study → studi (meets studies)
  if (r.endsWith("e") && r.length > 3) r = r.slice(0, -1); // file → fil (meets files)
  return r.length >= 3 ? r : t;
}

export function bm25Tokenize(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.split(TOKEN_SPLIT)) {
    if (raw === "") continue;
    const lowered = raw.toLowerCase();
    out.push(stem(lowered));
    if (raw.length > 3) {
      const parts = raw.split(CAMEL_SPLIT);
      if (parts.length > 1) {
        for (const part of parts) {
          const piece = part.toLowerCase();
          if (piece !== "" && piece !== lowered) out.push(stem(piece));
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

/** Ranking knobs (frozen option bags; defaults enable the full V2 pipeline). */
export interface Bm25RankOptions {
  /** Pseudo-relevance-feedback query expansion (auto-off below PRF_MIN_DOCS docs). */
  readonly prf?: boolean;
  /** Adjacent-bigram phrase bonus over a re-rank pool. */
  readonly phraseBonus?: boolean;
}
export const BM25_RANK_DEFAULTS: Readonly<Bm25RankOptions> = Object.freeze({
  prf: true,
  phraseBonus: true,
});

/**
 * Positive-scoring docs as (idx, score) pairs, best first. The Python twin's score dict only
 * ever holds docs with ≥1 matching term; a dense TS array would otherwise let zero-score docs
 * into PRF feedback and the phrase pool — a divergence the parity suite catches.
 */
function positivePairs(scores: readonly number[]): readonly (readonly [number, number])[] {
  const pairs: (readonly [number, number])[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > 0) pairs.push([i, scores[i]]);
  }
  pairs.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return pairs;
}

/**
 * Rank entries against a query, best first, top-k, score > 0 only.
 * Pipeline mirrors retrieval.py:search — weighted scoring → PRF expansion → phrase bonus
 * over a re-rank pool → top-k. Pre-allocated arrays; no growth in the scoring loops.
 */
export function bm25Rank<T>(
  query: string,
  entries: readonly Bm25Entry<T>[],
  k: number,
  options: Bm25RankOptions = BM25_RANK_DEFAULTS,
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
  const idfOf = (term: string): number => {
    const df = postings.get(term)?.length ?? 0;
    return Math.log(1.0 + (n - df + 0.5) / (df + 0.5));
  };
  const score = (weights: ReadonlyMap<string, number>): number[] => {
    const scores = new Array<number>(n).fill(0);
    for (const [term, weight] of weights) {
      const posting = postings.get(term);
      if (posting === undefined) continue;
      const idf = idfOf(term);
      for (const [idx, tf] of posting) {
        const norm = BM25_K1 * (1.0 - BM25_B + BM25_B * (docLens[idx] / avgLen));
        scores[idx] += weight * idf * (tf * (BM25_K1 + 1.0)) / (tf + norm);
      }
    }
    return scores;
  };

  const weights = new Map<string, number>();
  for (const term of bm25Tokenize(query)) {
    if (!weights.has(term)) weights.set(term, 1.0); // Python twin: first occurrence wins
  }
  let scores = score(weights);
  const basePositive = positivePairs(scores);
  if (options.prf !== false && n >= PRF_MIN_DOCS && basePositive.length > 0) {
    const feedback = basePositive.slice(0, PRF_FEEDBACK_DOCS).map(([idx]) => idx);
    const tf = new Map<string, number>();
    for (const idx of feedback) {
      for (const term of bm25Tokenize(entries[idx].text)) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
    }
    // Exclude query terms BEFORE slicing — the twin (retrieval.py:_expansion_terms) excludes
    // first, then takes the top-8; slicing first would let query terms eat expansion slots.
    const ranked: readonly (readonly [number, string])[] = Array.from(tf, ([term, f]) => [f * idfOf(term), term] as const)
      .filter(([, term]) => !weights.has(term))
      .sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .slice(0, PRF_EXPANSION_TERMS);
    let added = false;
    for (const [, term] of ranked) {
      if (!weights.has(term)) {
        weights.set(term, PRF_EXPANSION_WEIGHT);
        added = true;
      }
    }
    if (added) scores = score(weights);
  }
  if (scores.every((s) => s <= 0)) return [];

  // Pool of (idx, score) pairs — the phrase bonus MUTATES the score (twin parity), so the
  // reported value must come from the pool pairs, not the pre-bonus score array.
  const positive = positivePairs(scores);
  const poolN = Math.min(positive.length, RERANK_POOL_CAP, Math.max(k * RERANK_POOL_MULT, PRF_FEEDBACK_DOCS));
  let pool = positive.slice(0, poolN);
  const seq = bm25Tokenize(query); // raw sequence — repeated terms make self-bigrams, like Python
  const bigrams: (readonly [string, string])[] = [];
  if (options.phraseBonus !== false) {
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] !== seq[i + 1] && !bigrams.some(([a, b]) => a === seq[i] && b === seq[i + 1])) {
        bigrams.push([seq[i], seq[i + 1]]);
      }
    }
  }
  if (bigrams.length > 0) {
    const boosted = pool.map(([idx, s]) => {
      const toks = bm25Tokenize(entries[idx].text);
      const pos = new Map<string, number[]>();
      for (let i = 0; i < toks.length; i++) {
        const list = pos.get(toks[i]);
        if (list !== undefined) list.push(i);
        else pos.set(toks[i], [i]);
      }
      let bonus = 0;
      for (const [a, b] of bigrams) {
        const pa = pos.get(a);
        const pb = pos.get(b);
        if (pa !== undefined && pb !== undefined && pa.some((x) => pb.some((y) => y === x + 1))) {
          bonus += PHRASE_BONUS_WEIGHT * Math.max(idfOf(a), idfOf(b));
        }
      }
      return [idx, s + bonus] as const;
    });
    boosted.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    pool = boosted;
  }

  const out: Bm25Hit<T>[] = [];
  for (const [idx, s] of pool) {
    if (out.length >= k) break;
    if (s > 0) out.push({ item: entries[idx].item, score: s });
  }
  return out;
}
