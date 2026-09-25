"""Deterministic retrieval over `context` — free: no sub-LLM call, no root tokens.

`search` / `grep_context` / `outline` are what the prompt tells the model to reach for BEFORE
delegating anything, so they carry no worker state: each takes the already-materialised
`entries` list and returns pointers, never file bodies.

BM25 V2 (twin: util/bm25.ts — keep the two files in lockstep, AGENTS.md duality convention):
light suffix stemming, bigram phrase bonus, and pseudo-relevance-feedback query expansion
(Rocchio without embeddings — the LLM Agent Memory Survey's query-reformulation line, fully
deterministic). Windows overlap by half so evidence straddling a boundary stops diluting.
"""

from __future__ import annotations

import fnmatch
import heapq
import math
import re
from typing import Any


_CHUNK_HEADER_OVERHEAD = 64
_MAX_CHUNK_BATCH = 20          # fan-out per llm_batch call (matches prompt guidance)
_MAX_CHUNKS = 500              # ceiling: above this, force pre-filtering in Python
_NUDGE_CHARS = 500_000         # str/bytes vars above this trigger a one-time stdout hint


def _chunk_text(text: str, chunk_chars: int) -> list[str]:
    """Split text into <=chunk_chars pieces, preferring newline boundaries."""
    chunks: list[str] = []
    n = len(text)
    start = 0
    while start < n:
        end = min(start + chunk_chars, n)
        if end < n:
            nl = text.rfind("\n", start, end)
            if nl > start:
                end = nl + 1
        chunks.append(text[start:end])
        start = end
    return chunks


def _snippet_window(text: str, terms: set[str]) -> str:
    """Slice `text` around the earliest occurrence of any query term, capped at _SNIPPET_CHARS.

    BM25 finds the right window chunk; the snippet must show the match, not the chunk head.
    Clipped edges get "..." markers, which count toward the cap (the body is trimmed to fit).
    Falls back to the chunk head when no term occurs (tokenize/camelCase mismatches).
    """
    lowered = text.lower()
    hits = [p for p in (lowered.find(t) for t in terms) if p >= 0]
    if not hits:
        return text[:_SNIPPET_CHARS]
    start = max(0, min(hits) - _SNIPPET_LEAD)
    end = min(len(text), start + _SNIPPET_CHARS)
    lead = "..." if start > 0 else ""
    trail = "..." if end < len(text) else ""
    body = text[start:end]
    if len(body) > _SNIPPET_CHARS - len(lead) - len(trail):
        body = body[:_SNIPPET_CHARS - len(lead) - len(trail)]
    if start + len(body) < len(text):
        trail = "..."  # trimming pulled the window edge back inside the chunk
        body = body[:_SNIPPET_CHARS - len(lead) - len(trail)]
    return lead + body + trail


# ---- deterministic retrieval over `context` -----------------------------------------------
#
# The RLM paper's trajectories retrieve by having the root model hand-write regex over the
# context (App. E.1). Frontier models do that well; small/fast models guess keywords badly and
# the first decomposition attempt disproportionately decides the outcome (paper §5, Fig. 4a).
# These primitives make retrieval deterministic and token-free: no sub-LLM call, no root tokens
# spent on printed file bodies — the model gets ranked pointers and decides what to delegate.


_INDEX_WINDOW_LINES = 40       # a window is the retrieval unit: big enough to carry meaning
_INDEX_WINDOW_STRIDE = 20      # windows overlap by half so boundary-straddled evidence survives
_INDEX_MAX_WINDOWS = 20_000    # ceiling so a huge add_context() cannot exhaust worker memory
_SNIPPET_CHARS = 400
_SNIPPET_LEAD = 100            # chars of lead-in kept before the earliest matched term
_GREP_HARD_CAP = 200           # absolute ceiling on returned grep hits, whatever k asks for
_BM25_K1 = 1.2
_BM25_B = 0.75

# BM25 V2 constants (twin: util/bm25.ts — identical values there).
_PRF_FEEDBACK_DOCS = 3         # top first-pass windows harvested for expansion terms
_PRF_EXPANSION_TERMS = 8       # max terms added by pseudo-relevance feedback
_PRF_EXPANSION_WEIGHT = 0.4    # Rocchio beta: expansion terms contribute at this weight
_PRF_MIN_DOCS = 12             # below this the corpus is too small to harvest from
_PHRASE_BONUS_WEIGHT = 0.25    # per adjacent query-bigram occurrence in a window
_RERANK_POOL_MULT = 3          # phrase-bonus pool = top (k * mult) windows, capped
_RERANK_POOL_CAP = 60
_STEM_MIN_LEN = 4              # tokens shorter than this are never stemmed

_TOKEN_SPLIT = re.compile(r"[^0-9A-Za-z]+")     # also splits snake_case and paths
_CAMEL_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")

# Definition-ish lines across the languages this plugin is likely to meet. Deliberately
# lexical: an outline is an orientation aid, not a parse tree.
_OUTLINE_LINE = re.compile(
    r"^\s*(?:"
    r"(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|namespace)\s+\w+"
    r"|(?:export\s+)?(?:const|let|var)\s+\w+\s*[:=]\s*(?:async\s*)?(?:function|\(|<)"
    r"|(?:pub\s+)?(?:async\s+)?fn\s+\w+"
    r"|def\s+\w+|class\s+\w+"
    r"|func\s+\w+"
    r"|#{1,4}\s+\S"
    r")"
)


def _stem(t: str) -> str:
    """Light deterministic suffix stripper (TWIN: util/bm25.ts `stem` — identical rules).

    A matching aid, not linguistics: different surface forms converge (files/file → fil,
    running/run → run, studies/study → studi); identical forms always map to themselves.
    Final `y`→`i` and trailing-`e` deletion are what make the folds meet.
    """
    if len(t) <= 3:
        return t
    if t.endswith("ies"):
        r = t[:-3] + "i"                                   # studies → studi
    elif t.endswith("sses"):
        r = t[:-2]                                         # classes → class
    elif t.endswith("es"):
        stem2 = t[:-2]
        if stem2.endswith(("x", "ch", "sh")):
            r = stem2                                      # boxes → box, matches → match
        else:
            r = t[:-1]                                     # files → file
    elif t.endswith("s") and not t.endswith(("ss", "us", "is")):
        r = t[:-1] if len(t) > 4 else t                    # cats → cat; keeps "was"/"its"
    else:
        r = t
    if r.endswith("ing") and len(r) >= 6:
        base = r[:-3]                                      # running → runn
        if len(base) >= 4:
            if len(base) >= 2 and base[-1] == base[-2]:
                base = base[:-1]                           # runn → run
            r = base                                       # "string" stays whole
    elif r.endswith("ed") and len(r) >= 5:
        base = r[:-2]                                      # mapped → mapp
        if len(base) >= 4:
            if len(base) >= 2 and base[-1] == base[-2]:
                base = base[:-1]                           # mapp → map
            r = base
    if r.endswith("y") and len(r) > 3:
        r = r[:-1] + "i"                                   # study → studi (meets studies)
    if r.endswith("e") and len(r) > 3:
        r = r[:-1]                                         # file → fil (meets files)
    return r if len(r) >= 3 else t


def _tokenize(text: str) -> list[str]:
    """Lowered alphanumeric runs + camelCase parts, all stemmed (`resolveModelId` ↔ model ids)."""
    out: list[str] = []
    for raw in _TOKEN_SPLIT.split(text):
        if not raw:
            continue
        lowered = raw.lower()
        out.append(_stem(lowered))
        if len(raw) > 3:
            parts = _CAMEL_SPLIT.split(raw)
            if len(parts) > 1:
                for part in parts:
                    piece = part.lower()
                    if piece and piece != lowered:
                        out.append(_stem(piece))
    return out


def _context_entries(context: Any) -> list[tuple[str, str]]:
    """(path, content) pairs for either context shape: list[dict] bundles or a raw string."""
    if isinstance(context, str):
        return [("<context>", context)]
    if not isinstance(context, list):
        return []
    out: list[tuple[str, str]] = []
    for i, item in enumerate(context):
        if isinstance(item, dict):
            content = item.get("content", "")
            out.append((
                str(item.get("path", f"<context[{i}]>")),
                content if isinstance(content, str) else str(content),
            ))
        elif isinstance(item, str):
            out.append((f"<context[{i}]>", item))
    return out


class _Bm25Index:
    """Okapi BM25 over overlapping fixed-line windows of `context`. Built lazily, rebuilt on change."""

    __slots__ = ("paths", "starts", "ends", "texts", "postings", "doc_len", "avg_len", "truncated")

    def __init__(self, entries: list[tuple[str, str]]) -> None:
        self.paths: list[str] = []
        self.starts: list[int] = []
        self.ends: list[int] = []
        self.texts: list[str] = []
        self.postings: dict[str, list[tuple[int, int]]] = {}
        self.doc_len: list[int] = []
        self.truncated = False

        for path, content in entries:
            if not content:
                continue
            lines = content.split("\n")
            for start in range(0, len(lines), _INDEX_WINDOW_STRIDE):
                window_lines = lines[start:start + _INDEX_WINDOW_LINES]
                # The tail window fully covered by the previous one adds nothing — skip it.
                if start > 0 and len(window_lines) <= _INDEX_WINDOW_STRIDE:
                    break
                if len(self.texts) >= _INDEX_MAX_WINDOWS:
                    self.truncated = True
                    break
                window = "\n".join(window_lines)
                idx = len(self.texts)
                self.paths.append(path)
                self.starts.append(start + 1)
                self.ends.append(start + len(window_lines))
                self.texts.append(window)
                terms = _tokenize(window)
                self.doc_len.append(len(terms))
                freq: dict[str, int] = {}
                for term in terms:
                    freq[term] = freq.get(term, 0) + 1
                for term, tf in freq.items():
                    self.postings.setdefault(term, []).append((idx, tf))
            if self.truncated:
                break

        total = len(self.doc_len)
        self.avg_len = (sum(self.doc_len) / total) if total else 1.0

    def idf(self, term: str) -> float:
        total = len(self.doc_len)
        if total == 0:
            return 0.0
        df = len(self.postings.get(term, ()))
        return math.log(1.0 + (total - df + 0.5) / (df + 0.5))

    def glob_allow(self, path_glob: str | None) -> set[int] | None:
        """Pre-filter: window indices whose path matches the glob (None = everything).

        Pre-filtering before scoring (not after) so glob-matched windows outside the global
        top-k still surface — a post-scoring filter could return fewer than k.
        """
        if not path_glob:
            return None
        return {i for i, p in enumerate(self.paths) if fnmatch.fnmatch(p, path_glob)}

    def score(self, weights: dict[str, float], allowed: set[int] | None) -> dict[int, float]:
        """Weighted Okapi accumulation: scores[idx] += weight * idf * tf-sat (set-ordered input)."""
        total = len(self.texts)
        if total == 0:
            return {}
        scores: dict[int, float] = {}
        for term, weight in weights.items():
            posting = self.postings.get(term)
            if not posting:
                continue
            idf = self.idf(term)
            for idx, tf in posting:
                if allowed is not None and idx not in allowed:
                    continue
                norm = _BM25_K1 * (1.0 - _BM25_B + _BM25_B * self.doc_len[idx] / self.avg_len)
                scores[idx] = scores.get(idx, 0.0) + weight * idf * (tf * (_BM25_K1 + 1.0)) / (tf + norm)
        return scores


def _top(scores: dict[int, float], n: int) -> list[tuple[int, float]]:
    """Top-n by (score desc, idx asc) — the deterministic tie-break the TS twin mirrors."""
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:n]


def _expansion_terms(index: _Bm25Index, feedback: list[int], exclude: set[str]) -> list[str]:
    """Pseudo-relevance-feedback terms: tf-in-feedback × global idf, best first (twin-mirrored).

    Harvested from the top first-pass windows; deterministic ties break by term codepoints.
    """
    tf: dict[str, int] = {}
    for idx in feedback:
        for term in _tokenize(index.texts[idx]):
            tf[term] = tf.get(term, 0) + 1
    scored: list[tuple[float, str]] = []
    for term, f in tf.items():
        if term in exclude:
            continue
        scored.append((f * index.idf(term), term))
    scored.sort(key=lambda st: (-st[0], st[1]))
    return [term for _, term in scored[:_PRF_EXPANSION_TERMS]]


def _phrase_bigrams(terms: list[str]) -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for a, b in zip(terms, terms[1:]):
        if a != b and (a, b) not in seen:
            seen.add((a, b))
            out.append((a, b))
    return out


def _adjacent(index: _Bm25Index, idx: int, bigrams: list[tuple[str, str]]) -> float:
    """Phrase bonus for one window: weight × max-idf per query bigram occurring adjacently."""
    if not bigrams:
        return 0.0
    toks = _tokenize(index.texts[idx])
    pos: dict[str, list[int]] = {}
    for i, t in enumerate(toks):
        pos.setdefault(t, []).append(i)
    bonus = 0.0
    for a, b in bigrams:
        pa, pb = pos.get(a), pos.get(b)
        if pa and pb and any(x + 1 == y for x in pa for y in pb):
            bonus += _PHRASE_BONUS_WEIGHT * max(index.idf(a), index.idf(b))
    return bonus


def search(entries: list[tuple[str, str]], index: _Bm25Index, query: str, k: int = 10, path_glob: str | None = None) -> list[dict[str, Any]]:
    """Rank `context` windows against a natural-language query (BM25 V2 pipeline).

    Pipeline: weighted scoring → PRF expansion (corpora ≥ _PRF_MIN_DOCS windows) → phrase
    bonus over a re-rank pool → top-k → adjacent-window merge. Returns [{path, line, score,
    snippet, text}] — pointers, not bodies; merged spans add `end`, an over-cap index adds
    `index_truncated`. `text` aliases `snippet` (same as grep_context hits).
    """
    terms = _tokenize(str(query))
    if not terms:
        return []
    try:
        limit = max(1, min(int(k), 100))
    except (TypeError, ValueError):
        limit = 10
    allowed = index.glob_allow(path_glob)
    weights: dict[str, float] = {}
    for t in terms:
        weights.setdefault(t, 1.0)
    scores = index.score(weights, allowed)
    if len(index.doc_len) >= _PRF_MIN_DOCS and scores:
        feedback = [idx for idx, _ in _top(scores, _PRF_FEEDBACK_DOCS)]
        expansion = _expansion_terms(index, feedback, set(weights))
        if expansion:
            for t in expansion:
                weights[t] = _PRF_EXPANSION_WEIGHT
            scores = index.score(weights, allowed)
    if not scores:
        return []
    pool_n = min(len(scores), _RERANK_POOL_CAP, max(limit * _RERANK_POOL_MULT, _PRF_FEEDBACK_DOCS))
    pool = _top(scores, pool_n)
    bigrams = _phrase_bigrams(terms)
    if bigrams:
        boosted = [(idx, score + _adjacent(index, idx, bigrams)) for idx, score in pool]
        boosted.sort(key=lambda kv: (-kv[1], kv[0]))
        pool = boosted
    top = pool[:limit]

    # Adjacent same-path windows merge into one wider hit (diversity: one file cannot flood k).
    merged: list[dict[str, Any]] = []
    for idx, score in top:
        path = index.paths[idx]
        start = index.starts[idx]
        end = index.ends[idx]
        if merged and merged[-1]["path"] == path and start <= int(merged[-1]["end"]) + 1:
            merged[-1]["end"] = max(int(merged[-1]["end"]), end)
            if score > float(merged[-1]["score"]):
                snip = _snippet_window(index.texts[idx], set(terms))
                merged[-1]["snippet"] = snip
                merged[-1]["text"] = snip
            merged[-1]["score"] = round(max(float(merged[-1]["score"]), score), 3)
        else:
            snip = _snippet_window(index.texts[idx], set(terms))
            merged.append({
                "path": path,
                "line": start,
                "end": end,
                "score": round(score, 3),
                "snippet": snip,
                "text": snip,
            })
    if index.truncated:
        for hit in merged:
            hit["index_truncated"] = True
    return merged


class _GrepResult(dict):
    """dict that explains a slice. Models write `grep_context(pat)[:k]` because `search` returns a list."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, slice):
            raise TypeError(
                "grep_context returns {hits, counts, total, truncated}; slice ['hits']"
            )
        return dict.__getitem__(self, key)


def grep_context(
    entries: list[tuple[str, str]],
    pattern: str,
    k: int = 50,
    path_glob: str | None = None,
    before: int = 0,
    after: int = 0,
    multiline: bool = True,
) -> dict[str, Any]:
    """Regex over `context`, capped and shaped.

    Returns {"hits": [{path, line, text, snippet}], "counts": {path: n}, "total": n, "truncated": bool}.
    `snippet` is an alias of `text` (same as search hits) to avoid KeyError footguns.
    `counts` is complete even when `hits` is capped.
    """
    try:
        # MULTILINE: the doc-level gate below must not veto line-anchored patterns (^/$) —
        # without it, `^foo` on a multi-line doc never matches outside position 0 and every
        # line hit is silently filtered out (grep is line-oriented; match that).
        flags = re.MULTILINE if multiline else 0
        rx = re.compile(pattern, flags)
    except re.error as e:
        return _GrepResult(hits=[], counts={}, total=0, truncated=False, error=f"bad regex: {e}")
    try:
        limit = max(1, min(int(k), _GREP_HARD_CAP))
    except (TypeError, ValueError):
        limit = 50
    pad_before = max(0, min(int(before or 0), 10))
    pad_after = max(0, min(int(after or 0), 10))

    hits: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    total = 0
    for path, content in entries:
        if path_glob and not fnmatch.fnmatch(path, path_glob):
            continue
        if not rx.search(content):
            continue
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if not rx.search(line):
                continue
            total += 1
            counts[path] = counts.get(path, 0) + 1
            if len(hits) >= limit:
                continue
            lo = max(0, i - pad_before)
            hi = min(len(lines), i + pad_after + 1)
            body = "\n".join(lines[lo:hi])[:_SNIPPET_CHARS]
            hits.append({
                "path": path,
                "line": i + 1,
                "text": body,
                "snippet": body,
            })
    return _GrepResult(hits=hits, counts=counts, total=total, truncated=total > len(hits))

def outline(entries: list[tuple[str, str]], path: str) -> str:
    """Definition/heading skeleton of one context file — orient in ~200 chars, not 20K.

    `path` matches exactly, then by suffix, then as a glob.
    """
    target = str(path)
    content: str | None = None
    for p, c in entries:
        if p == target:
            content = c
            break
    if content is None:
        for p, c in entries:
            if p.endswith(target) or fnmatch.fnmatch(p, target):
                content = c
                target = p
                break
    if content is None:
        return f"Error: no context file matching {path!r} — use search() or list paths from context"
    out: list[str] = [f"# {target}"]
    for i, line in enumerate(content.split("\n")):
        if _OUTLINE_LINE.match(line):
            out.append(f"{i + 1}: {line.strip()[:160]}")
    if len(out) == 1:
        return f"# {target}\n(no definition-like lines found)"
    return "\n".join(out)
