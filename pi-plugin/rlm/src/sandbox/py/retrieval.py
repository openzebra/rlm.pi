"""Deterministic retrieval over `context` — free: no sub-LLM call, no root tokens.

`search` / `grep_context` / `outline` are what the prompt tells the model to reach for BEFORE
delegating anything, so they carry no worker state: each takes the already-materialised
`entries` list and returns pointers, never file bodies.
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


# ---- deterministic retrieval over `context` -----------------------------------------------
#
# The RLM paper's trajectories retrieve by having the root model hand-write regex over the
# context (App. E.1). Frontier models do that well; small/fast models guess keywords badly and
# the first decomposition attempt disproportionately decides the outcome (paper §5, Fig. 4a).
# These primitives make retrieval deterministic and token-free: no sub-LLM call, no root tokens
# spent on printed file bodies — the model gets ranked pointers and decides what to delegate.


_INDEX_WINDOW_LINES = 40       # a window is the retrieval unit: big enough to carry meaning
_INDEX_MAX_WINDOWS = 20_000    # ceiling so a huge add_context() cannot exhaust worker memory
_SNIPPET_CHARS = 400
_GREP_HARD_CAP = 200           # absolute ceiling on returned grep hits, whatever k asks for
_BM25_K1 = 1.2
_BM25_B = 0.75

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


def _tokenize(text: str) -> list[str]:
    """Lowercased alphanumeric runs, plus camelCase parts so `resolveModelId` matches `model id`."""
    out: list[str] = []
    for raw in _TOKEN_SPLIT.split(text):
        if not raw:
            continue
        lowered = raw.lower()
        out.append(lowered)
        if len(raw) > 3:
            parts = _CAMEL_SPLIT.split(raw)
            if len(parts) > 1:
                for part in parts:
                    piece = part.lower()
                    if piece and piece != lowered:
                        out.append(piece)
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
    """Okapi BM25 over fixed-line windows of `context`. Built lazily, discarded on change."""

    __slots__ = ("paths", "starts", "texts", "postings", "doc_len", "avg_len", "truncated")

    def __init__(self, entries: list[tuple[str, str]]) -> None:
        self.paths: list[str] = []
        self.starts: list[int] = []
        self.texts: list[str] = []
        self.postings: dict[str, list[tuple[int, int]]] = {}
        self.doc_len: list[int] = []
        self.truncated = False

        for path, content in entries:
            if not content:
                continue
            lines = content.split("\n")
            for start in range(0, len(lines), _INDEX_WINDOW_LINES):
                if len(self.texts) >= _INDEX_MAX_WINDOWS:
                    self.truncated = True
                    break
                window = "\n".join(lines[start:start + _INDEX_WINDOW_LINES])
                idx = len(self.texts)
                self.paths.append(path)
                self.starts.append(start + 1)
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

    def query(self, terms: list[str], k: int, path_glob: str | None) -> list[dict[str, Any]]:
        total = len(self.texts)
        if total == 0:
            return []
        scores: dict[int, float] = {}
        for term in set(terms):
            posting = self.postings.get(term)
            if not posting:
                continue
            df = len(posting)
            idf = math.log(1.0 + (total - df + 0.5) / (df + 0.5))
            for idx, tf in posting:
                norm = _BM25_K1 * (1.0 - _BM25_B + _BM25_B * self.doc_len[idx] / self.avg_len)
                scores[idx] = scores.get(idx, 0.0) + idf * (tf * (_BM25_K1 + 1.0)) / (tf + norm)
        if path_glob:
            scores = {i: s for i, s in scores.items() if fnmatch.fnmatch(self.paths[i], path_glob)}
        if not scores:
            return []
        top = heapq.nlargest(k, scores.items(), key=lambda kv: kv[1])
        out: list[dict[str, Any]] = [None] * len(top)  # type: ignore[list-item]
        for i, (idx, score) in enumerate(top):
            text = self.texts[idx]
            out[i] = {
                "path": self.paths[idx],
                "line": self.starts[idx],
                "score": round(score, 3),
                "snippet": text[:_SNIPPET_CHARS],
            }
        return out


def search(entries: list[tuple[str, str]], index: _Bm25Index, query: str, k: int = 10, path_glob: str | None = None) -> list[dict[str, Any]]:
    """Rank `context` windows against a natural-language query (BM25).

    Returns [{path, line, score, snippet}] — pointers, not bodies. Follow up by slicing the
    named files out of `context` and delegating them to llm_query / map_files.
    """
    terms = _tokenize(str(query))
    if not terms:
        return []
    try:
        limit = max(1, min(int(k), 100))
    except (TypeError, ValueError):
        limit = 10
    return index.query(terms, limit, path_glob)

def grep_context(
    entries: list[tuple[str, str]],
    pattern: str,
    k: int = 50,
    path_glob: str | None = None,
    before: int = 0,
    after: int = 0,
) -> dict[str, Any]:
    """Regex over `context`, capped and shaped.

    Returns {"hits": [{path, line, text}], "counts": {path: n}, "total": n, "truncated": bool}.
    `counts` is complete even when `hits` is capped, so a wide pattern reports its shape
    instead of flooding stdout.
    """
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return {"hits": [], "counts": {}, "total": 0, "truncated": False, "error": f"bad regex: {e}"}
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
            hits.append({"path": path, "line": i + 1, "text": "\n".join(lines[lo:hi])[:_SNIPPET_CHARS]})
    return {"hits": hits, "counts": counts, "total": total, "truncated": total > len(hits)}

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
