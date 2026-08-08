"""RLM sandbox worker: a persistent Python REPL driven over a JSONL stdio protocol.

Executes model-authored Python with secrets stripped from the environment.
This is NOT a security sandbox: __import__ and open are available, so code can import networking modules
(socket, urllib, subprocess) and read/write local files. Trust the root model's code.

Protocol (parent -> worker):  {"id","type":"exec"|"load_context"|"shutdown", ...}
Protocol (worker -> parent):  {"id","ok",...result}            # response to a request
                              {"type":"llm_query"|"llm_query_batched"|"rlm_query"|...
                               "advance_phase"|"save_artifact"|"ask_user_question"|"todo","rid",...}
                                                                # mid-exec helper request
When sandbox code calls llm_query/rlm_query/advance_phase/save_artifact/ask_user_question/todo, the worker writes a request line
and BLOCKS reading stdin until the matching {"type":"llm_reply","rid",...} arrives. The parent
services the request in-process (it holds API keys).

Requests and replies are decoupled: `_post` writes a request and returns its rid without
waiting, and replies are parked in `_inbox` keyed by rid until something asks for them. That
is what makes `spawn()` / `rlm_await()` / `rlm_await_all()` possible — many requests can be
in flight at once (the parent already services interrupts concurrently), and a task may be
awaited in a LATER exec than the one that started it.
"""

from __future__ import annotations

import argparse
import fnmatch
import heapq
import io
import json
import math
import os
import pickle
import re
import signal
import sys
import time
import traceback
from contextlib import contextmanager
from typing import Any

# Capture the REAL stdio before exec() redirects sys.stdout/sys.stderr into buffers.
# All protocol writes must go to the real stdout even while user code's prints are captured.
_REAL_STDOUT = sys.stdout
_REAL_STDIN = sys.stdin
_REAL_STDERR = sys.stderr


def _builtin(name: str):
    return __builtins__[name] if isinstance(__builtins__, dict) else getattr(__builtins__, name, None)


# Restricted builtins: enough for real data work, minus the dangerous reflection escapes.
_SAFE_BUILTINS = {
    name: _builtin(name)
    for name in (
        "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes", "callable",
        "chr", "classmethod", "complex", "dict", "dir", "divmod", "enumerate", "filter",
        "float", "format", "frozenset", "getattr", "hasattr", "hash", "hex", "id", "int",
        "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min", "next",
        "object", "oct", "ord", "pow", "print", "property", "range", "repr", "reversed",
        "round", "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
        "tuple", "type", "vars", "zip", "delattr", "memoryview", "__import__", "__build_class__",
        "Exception", "BaseException", "ValueError", "TypeError", "KeyError", "IndexError",
        "AttributeError", "FileNotFoundError", "OSError", "IOError", "RuntimeError",
        "NameError", "ImportError", "StopIteration", "AssertionError", "NotImplementedError",
        "ArithmeticError", "ZeroDivisionError", "LookupError", "Warning", "True", "False", "None",
    )
}
# `open` is allowed for data work; eval/exec/compile/input/globals/locals are not.
# When read_only=True (pipeline runs), write modes raise PermissionError via
# builtins.open, io.open (pathlib), and os.open. Steering, not a security sandbox.
_WRITE_MODE_CHARS = frozenset("wax+")
_OS_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC

_REAL_IO_OPEN = io.open
_REAL_OS_OPEN = os.open


def _install_read_only_guards():
    """Route every common file-open path through the read-only check.

    Steering, not a sandbox: closes builtins.open, io.open (hence pathlib), and
    os.open. A determined model can still reach the filesystem via ctypes or a
    subprocess — the goal is that ACCIDENTAL writes cannot pass silently.
    Worker-internal I/O keeps using _REAL_IO_OPEN / _REAL_OS_OPEN.
    """
    def guarded_io_open(file, mode="r", *args, **kwargs):
        if _WRITE_MODE_CHARS & set(str(mode)):
            raise PermissionError(
                f"read-only RLM run: refusing to open {file!r} with mode {mode!r}. "
                "This pipeline produces a plan; file changes go through the host edit tool."
            )
        return _REAL_IO_OPEN(file, mode, *args, **kwargs)

    def guarded_os_open(path, flags, *args, **kwargs):
        if flags & _OS_WRITE_FLAGS:
            raise PermissionError(
                f"read-only RLM run: refusing os.open({path!r}) with write flags."
            )
        return _REAL_OS_OPEN(path, flags, *args, **kwargs)

    io.open = guarded_io_open
    os.open = guarded_os_open
    return guarded_io_open


# _builtin()'s getattr(..., None) fallback would silently inject None for a name this
# interpreter lacks, surfacing much later as "'NoneType' object is not callable" inside model
# code. Fail at startup instead. Note "None" is legitimately None, and the block-list below is
# deliberate — which is why this check runs BEFORE it.
_MISSING = sorted(name for name, value in _SAFE_BUILTINS.items() if value is None and name != "None")
if _MISSING:
    raise RuntimeError(f"unsupported Python interpreter: missing builtins {_MISSING}")

def _blocked_builtin(name: str):
    """Bind a disabled builtin to a callable that explains itself.

    Binding these to None made `eval(...)` fail with a bare "'NoneType' object is not callable",
    which reads as a broken sandbox rather than a deliberate block: an audit session spent six
    execs on it and filed a phantom "namespace corruption" bug. Saying so at the point of failure
    fixes it for every model without spending native-prompt budget on a rule most runs never hit.
    """
    def blocked(*_args, **_kwargs):
        raise PermissionError(
            f"{name}() is disabled in the RLM sandbox by design — it is not missing and the "
            "namespace is not corrupt. Names are already bound, so reference them directly; "
            "inspect `context` with search() / grep_context() / outline()."
        )
    blocked.__name__ = name
    return blocked


# Blocked on purpose (NOT missing) — see _blocked_builtin. The _MISSING check above runs first,
# so a genuinely absent builtin is still a startup failure rather than a silent None.
for _blocked in ("eval", "exec", "compile", "input", "globals", "locals"):
    _SAFE_BUILTINS[_blocked] = _blocked_builtin(_blocked)

RESERVED = frozenset(
    {
        "llm_query", "llm_query_batched", "llm_query_chunked",
        "rlm_query", "rlm_query_batched",
        "spawn", "rlm_await", "rlm_await_all",
        "map_files", "llm_map_reduce",
        "search", "grep_context", "outline",
        "advance_phase", "save_artifact",
        "ask_user_question", "todo",
        "load_library",
        "SHOW_VARS", "answer", "context",
    }
)
# NOTE: `answers` and `plan` are deliberately NOT reserved. They are seeded by the scaffold but
# owned by the model, so they must appear in SHOW_VARS and be captured by snapshots — losing a
# memoized answer across a resume is exactly the failure the memo exists to prevent.
# Only the single name `context` is the packed world. Legacy context_N names are filtered out.
_CONTEXT_NAME = re.compile(r"context(_\d+)?\Z")

# Sizing for llm_query_chunked: leave room for the instruction and the chunk header.
_CHUNK_HEADER_OVERHEAD = 64
_MAX_CHUNK_BATCH = 20          # fan-out per llm_query_batched call (matches prompt guidance)
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
_INDEX_MAX_WINDOWS = 20_000    # ceiling so a huge load_library() cannot exhaust worker memory
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


class _AnswerDict(dict):
    """`answer` dict; flipping `ready` True captures the final answer for the parent."""

    def __init__(self, on_ready):
        super().__init__()
        super().__setitem__("content", "")
        super().__setitem__("ready", False)
        self._on_ready = on_ready

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key == "ready" and value:
            self._on_ready(self.get("content", ""))


def _send(obj: dict[str, Any]) -> None:
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


class _StallTimeout(Exception):
    """No frame from the host while a sub-call was pending."""


@contextmanager
def _stall_alarm(exec_timeout_s: float, stall_timeout_s: float):
    """Swap the per-cell alarm for a stall alarm while blocked on the parent.

    Sub-LLM latency is network time, not cell compute time, so it must not count against the
    ```repl``` block timeout — but an unbounded wait is exactly how a lost reply turns into a
    dead session. The yielded `rearm()` restarts the stall clock on every frame, so a healthy
    long-running child never trips it.
    """
    use = hasattr(signal, "SIGALRM")
    remaining = signal.getitimer(signal.ITIMER_REAL)[0] if (use and exec_timeout_s > 0) else 0.0

    def _fire(signum, frame):  # noqa: ARG001
        raise _StallTimeout(
            f"sub-call stalled — no reply from the host for {stall_timeout_s:g}s "
            "(the task may still be running; rlm_await it again in a later block)"
        )

    old = signal.signal(signal.SIGALRM, _fire) if use else None

    def rearm() -> None:
        if use and stall_timeout_s > 0:
            signal.setitimer(signal.ITIMER_REAL, stall_timeout_s)

    rearm()
    try:
        yield rearm
    finally:
        if use:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if old is not None:
                signal.signal(signal.SIGALRM, old)
            if remaining > 0:                      # restore the cell's remaining budget
                signal.setitimer(signal.ITIMER_REAL, remaining)


def _clean_paths(paths: Any) -> list[str] | None:
    """Normalize a `paths=` argument to a non-empty list of prefixes, or None.

    Shared by the single and batched rlm_query builders so the accepted shapes stay identical.
    A bare string is treated as one prefix — the most common typo, and harmless to allow.
    """
    if paths is None:
        return None
    seq = [paths] if isinstance(paths, str) else list(paths)
    out = [str(p).strip() for p in seq if str(p).strip()]
    return out or None


def _surfaced_error(message: str) -> str:
    """The "Error: …" contract value, ALSO written to the cell's stderr.

    A spawn/await misuse whose only trace is the returned value reads to the model as a random
    string much later — which is exactly how `tasks.items()` blew up on a str.
    """
    print(f"[rlm] {message}", file=sys.stderr)
    return f"Error: {message}"


# ---- reply reducers: raw parent replies -> the value the scaffold fn returns ----------------
# One reducer per result shape, shared by the sync helpers and their spawned equivalents.


def _reduce_one(replies: list[dict[str, Any]]) -> str:
    r = replies[0]
    return f"Error: {r['error']}" if r.get("error") else r.get("response", "")


def _reduce_batch(n: int):
    """Reducer for a single *_query_batched reply of n prompts."""
    def reduce(replies: list[dict[str, Any]]) -> list[str]:
        r = replies[0]
        if r.get("error"):
            return [f"Error: {r['error']}"] * n
        out = r.get("responses")
        if not isinstance(out, list) or len(out) != n:
            return ["Error: malformed batched response"] * n
        return [s if isinstance(s, str) else f"Error: {s}" for s in out]
    return reduce


def _reduce_chunked(sizes: list[int]):
    """Concatenate several llm_query_batched replies back into one flat chunk list."""
    per = [_reduce_batch(n) for n in sizes]

    def reduce(replies: list[dict[str, Any]]) -> list[str]:
        out: list[str] = []
        for red, rep in zip(per, replies):
            out.extend(red([rep]))
        return out
    return reduce


def _reduce_map_files(sizes: list[int], spans: list[tuple[str, int]]):
    """Flatten the batch replies (same as chunked), then regroup them per path.

    A file larger than the per-prompt budget contributed several requests; its answers rejoin
    in order, which is what makes map_files a {path: answer} dict rather than a flat list.
    """
    flatten = _reduce_chunked(sizes)

    def reduce(replies: list[dict[str, Any]]) -> dict[str, str]:
        responses = flatten(replies)
        out: dict[str, str] = {}
        cursor = 0
        for path, count in spans:
            part = responses[cursor:cursor + count]
            cursor += count
            out[path] = part[0] if count == 1 and part else "\n\n".join(part)
        return out
    return reduce


def _spawnable(name: str):
    """Tag a sync scaffold fn with the request kind spawn() should route it to."""
    def mark(fn):
        fn._rlm_name = name
        return fn
    return mark


class Task:
    """Handle for parent-side work in flight, returned by spawn().

    Opaque to model code apart from `done` and repr. A Task may be awaited in a later
    ```repl``` block than the one that created it.
    """

    __slots__ = ("kind", "label", "_worker", "_rids", "_reduce", "_value", "_settled")

    def __init__(self, worker: "Worker", kind: str, rids, reduce, label: str = ""):
        self.kind = kind
        self.label = label
        self._worker = worker
        self._rids = tuple(rids)
        self._reduce = reduce
        self._value: Any = None
        self._settled = False

    @staticmethod
    def resolved(worker: "Worker", kind: str, value: Any, label: str = "") -> "Task":
        """A Task that never hit the wire — validation errors and empty inputs."""
        task = Task(worker, kind, (), lambda _replies: value, label)
        task._value = value
        task._settled = True
        return task

    @property
    def done(self) -> bool:
        """True once every reply has landed — awaiting will not block."""
        return self._settled or all(r in self._worker.inbox for r in self._rids)

    def __repr__(self) -> str:
        return f"<Task {self.kind} {'done' if self.done else 'running'} {self.label}>"


class Worker:
    def __init__(
        self,
        depth: int,
        exec_timeout_s: float,
        max_prompt_chars: int,
        read_only: bool = False,
        await_timeout_s: float = 600.0,
    ):
        self.depth = depth
        self.exec_timeout_s = exec_timeout_s
        self.max_prompt_chars = max_prompt_chars
        self.read_only = read_only
        self.await_timeout_s = await_timeout_s
        self._rid = 0
        self._final_answer: str | None = None
        # Replies parked by rid until something awaits them. Unbounded by design: a task
        # the model spawns and never awaits keeps its entry for the life of the process.
        # Bounded in practice by session length; evicting would silently hang a later
        # rlm_await, which is strictly worse than the memory.
        self.inbox: dict[str, dict[str, Any]] = {}
        self._inflight: set[str] = set()
        # Requests (exec/snapshot/shutdown) that arrived mid-exec; main() replays them.
        self._deferred: list[Any] = []
        # True only while spawn() runs a builder — marks requests that may outlive this exec.
        self._detached = False
        self.ns: dict[str, Any] = {}
        self._setup()

    def _setup(self) -> None:
        builtins = _SAFE_BUILTINS.copy()
        if self.read_only:
            builtins["open"] = _install_read_only_guards()
        else:
            builtins["open"] = open
        self.ns = {"__builtins__": builtins, "__name__": "__main__"}
        self._context_payload: Any | None = None  # pristine restore for the single `context` var
        self._nudged: set[str] = set()
        self._index: _Bm25Index | None = None
        self._index_stamp: tuple[int, int] | None = None  # (id(context), len(context))
        self._restore_scaffold()

    def _capture_answer(self, content: Any) -> None:
        self._final_answer = str(content)

    def _restore_scaffold(self) -> None:
        # Re-inject any scaffolding the user code clobbered.
        ns = self.ns
        ns["llm_query"] = self._llm_query
        ns["llm_query_batched"] = self._llm_query_batched
        ns["llm_query_chunked"] = self._llm_query_chunked
        ns["rlm_query"] = self._rlm_query
        ns["rlm_query_batched"] = self._rlm_query_batched
        ns["spawn"] = self._spawn
        ns["rlm_await"] = self._await_task
        ns["rlm_await_all"] = self._await_all
        ns["map_files"] = self._map_files
        ns["llm_map_reduce"] = self._llm_map_reduce
        ns["search"] = self._search
        ns["grep_context"] = self._grep_context
        ns["outline"] = self._outline
        # env_tips memo (paper App. C.3): "If a value isn't in `answers`, it doesn't exist."
        # Re-created only when deleted — contents must survive every turn.
        if not isinstance(ns.get("answers"), dict):
            ns["answers"] = {}
        if not isinstance(ns.get("plan"), dict):
            ns["plan"] = {}
        ns["advance_phase"] = self._advance_phase
        ns["save_artifact"] = self._save_artifact
        ns["ask_user_question"] = self._ask_user_question
        ns["todo"] = self._todo
        ns["load_library"] = self._load_library
        ns["SHOW_VARS"] = self._show_vars
        if not isinstance(ns.get("answer"), _AnswerDict):
            cur = ns.get("answer")
            ans = _AnswerDict(self._capture_answer)
            if isinstance(cur, dict):
                for k, v in cur.items():
                    dict.__setitem__(ans, k, v)
                if cur.get("ready") and self._final_answer is None:
                    self._final_answer = str(cur.get("content", ""))
            ns["answer"] = ans
        # Single context variable (RLM paper: the context lives in the environment and
        # the model may transform it in place). Re-inject only if the model deleted the
        # name entirely; mutations and re-binds persist within the run.
        if self._context_payload is not None:
            ns.setdefault("context", self._context_payload)
        # Scrub any legacy context_N names so the model never sees multi-slot APIs.
        for k in list(ns.keys()):
            if k != "context" and _CONTEXT_NAME.match(k):
                del ns[k]

    def _user_var_names(self) -> list[str]:
        """User-created variable names — filters builtins, scaffold, and `context`.

        Shared by SHOW_VARS() and the exec result so both expose the same namespace view.
        This is the cheap orientation hint that goes into history instead of full stdout.
        """
        return [
            k for k in self.ns
            if not k.startswith("_")
            and not _CONTEXT_NAME.match(k)
            and k not in RESERVED
        ]

    def _show_vars(self) -> str:
        avail = {k: type(self.ns[k]).__name__ for k in self._user_var_names()}
        return f"Available variables: {avail}" if avail else "No variables created yet."

    # ---- sub-LLM bridge over stdio --------------------------------------------------------

    def _post(self, kind: str, payload: dict[str, Any]) -> str:
        """Write one parent request and return its rid WITHOUT waiting for the reply."""
        self._rid += 1
        rid = f"q{self._rid}"
        # Register only after the write succeeds — a broken pipe must not leave an
        # _inflight entry that nothing will ever settle.
        _send({"type": kind, "rid": rid, "depth": self.depth,
               "detached": self._detached, **payload})
        self._inflight.add(rid)
        return rid

    def park_reply(self, msg: Any) -> bool:
        """File an llm_reply against its rid. True when the frame was a reply.

        Public because main() needs it too: a spawned task can settle while the worker
        sits idle between execs, and that reply must not fall through to "unknown type".
        """
        if not isinstance(msg, dict) or msg.get("type") != "llm_reply":
            return False
        rid = msg.get("rid")
        if isinstance(rid, str) and rid in self._inflight:
            self._inflight.discard(rid)
            self.inbox[rid] = msg
        else:
            # Late reply to an abandoned rid (e.g. a request from a discarded sandbox).
            print(f"[rlm-sandbox] dropping reply for unknown rid: {rid!r}", file=_REAL_STDERR)
        return True

    def take_deferred(self) -> Any | None:
        """Pop a request that arrived mid-exec, for main() to replay. None when empty."""
        return self._deferred.pop(0) if self._deferred else None

    def _pump(self) -> bool:
        """Read one frame from the parent into the inbox. False when the pipe closed."""
        line = _REAL_STDIN.readline()
        if not line:
            return False
        try:
            msg = json.loads(line)
        except ValueError:
            print(f"[rlm-sandbox] skipping non-JSON parent frame: {line[:200]}", file=_REAL_STDERR)
            return True
        if self.park_reply(msg):
            return True
        # A request (exec/snapshot/shutdown) arriving mid-exec: main() replays it.
        self._deferred.append(msg)
        return True

    def _drain_until(self, rids) -> None:
        """Block until every rid in `rids` has its reply parked in the inbox.

        Bounded: a host that goes silent raises inside the ```repl``` block instead of hanging
        the session forever.
        """
        if all(r in self.inbox for r in rids):
            return
        with _stall_alarm(self.exec_timeout_s, self.await_timeout_s) as rearm:
            while not all(r in self.inbox for r in rids):
                if not self._pump():
                    raise RuntimeError("parent closed the pipe during a sub-LLM request")
                rearm()

    def _take(self, rids) -> list[dict[str, Any]]:
        return [self.inbox.pop(r) for r in rids]

    def _rpc(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Post one request and block for its reply — the synchronous single-shot path."""
        rid = self._post(kind, payload)
        self._drain_until((rid,))
        return self._take((rid,))[0]

    # ---- spawn / await ---------------------------------------------------------------------

    def _start_prompt(self, kind: str, prompt, model, paths=None) -> Task:
        text = str(prompt)
        # A sub-LLM asked nothing answers something: the confabulation then sits in `answers`
        # looking exactly like data. Refuse instead of spending a call on it.
        if not text.strip():
            return Task.resolved(self, kind, _surfaced_error(
                f"{kind}() got an empty prompt — a sub-LLM would confabulate an answer to nothing"))
        payload: dict[str, Any] = {"prompt": text, "model": model}
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return Task(self, kind, (rid,), _reduce_one, text[:40])

    def _start_prompts(self, kind: str, prompts, model, paths=None) -> Task:
        prompts = [str(p) for p in prompts]
        if not prompts:
            return Task.resolved(self, kind, [])
        # Only the all-blank case: one blank prompt among twenty is the caller's business.
        if not any(p.strip() for p in prompts):
            return Task.resolved(self, kind, [
                _surfaced_error(f"{kind}() got only empty prompts")
            ] * len(prompts))
        payload: dict[str, Any] = {"prompts": prompts, "model": model}
        # One prefix set for the whole batch: a per-prompt aligned list is an API nobody uses
        # correctly, and every prompt in a batch is asking about the same slice anyway.
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return Task(self, kind, (rid,), _reduce_batch(len(prompts)), f"×{len(prompts)}")

    def _start_llm_query(self, prompt, model: str | None = None) -> Task:
        return self._start_prompt("llm_query", prompt, model)

    def _start_rlm_query(self, prompt, model: str | None = None, paths=None) -> Task:
        return self._start_prompt("rlm_query", prompt, model, paths)

    def _start_llm_query_batched(self, prompts, model: str | None = None) -> Task:
        return self._start_prompts("llm_query_batched", prompts, model)

    def _start_rlm_query_batched(self, prompts, model: str | None = None, paths=None) -> Task:
        return self._start_prompts("rlm_query_batched", prompts, model, paths)

    def _start_llm_query_chunked(self, text, prompt: str, model: str | None = None) -> Task:
        """Split oversized text into cap-sized chunks and post EVERY batch at once.

        One answer per chunk, order preserved. No exceptions escape: errors come back as
        "Error: ..." strings per chunk (same contract as llm_query_batched). Because all
        batches go on the wire together, a large input costs one round-trip of latency
        rather than one per 20 chunks.

        NOTE: budget uses Python code-point length (len) while the parent-side cap check counts
        UTF-16 units (JS string.length); astral/emoji-heavy text may be marginally larger on the
        parent and get per-chunk rejected. Acceptable trade-off for typical code/log/profile text.
        """
        text, prompt = str(text), str(prompt)
        if not text:
            return Task.resolved(self, "llm_query_chunked", [])
        budget = self.max_prompt_chars - len(prompt) - _CHUNK_HEADER_OVERHEAD
        if budget < 1_000:
            return Task.resolved(self, "llm_query_chunked", [
                f"Error: prompt leaves under 1,000 chars per chunk (cap {self.max_prompt_chars:,}) — shorten the instruction"
            ])
        chunks = _chunk_text(text, budget)
        total = len(chunks)
        if total > _MAX_CHUNKS:
            return Task.resolved(self, "llm_query_chunked", [
                f"Error: {total} chunks would be needed — filter/slice the text in Python first"
            ])
        rids: list[str] = []
        sizes: list[int] = []
        for i in range(0, total, _MAX_CHUNK_BATCH):
            batch = [
                f"{prompt}\n\n[chunk {i + j + 1}/{total} of the input]\n{c}"
                for j, c in enumerate(chunks[i:i + _MAX_CHUNK_BATCH])
            ]
            rids.append(self._post("llm_query_batched", {"prompts": batch, "model": model}))
            sizes.append(len(batch))
        return Task(self, "llm_query_chunked", tuple(rids), _reduce_chunked(sizes), f"{total} chunks")

    def _builder_for(self, name: str):
        # llm_map_reduce is deliberately absent: its reduce step is a SECOND sub-LLM call that
        # depends on its own map results, so it cannot be one (rids, pure reduce) Task.
        return {
            "llm_query": self._start_llm_query,
            "llm_query_batched": self._start_llm_query_batched,
            "llm_query_chunked": self._start_llm_query_chunked,
            "map_files": self._start_map_files,
            "rlm_query": self._start_rlm_query,
            "rlm_query_batched": self._start_rlm_query_batched,
        }.get(name)

    def _spawn(self, fn, *args, **kwargs) -> Task:
        """Start a sub-call without waiting for it. `fn` is the scaffold function itself.

        Returns a Task for rlm_await / rlm_await_all, possibly in a later ```repl``` block.
        Misuse returns an already-resolved error Task rather than raising, matching the
        "Error: ..." contract of the synchronous helpers.
        """
        name = getattr(fn, "_rlm_name", None)
        builder = self._builder_for(name) if isinstance(name, str) else None
        if builder is None:
            return Task.resolved(self, "spawn", _surfaced_error(
                "spawn() takes llm_query, llm_query_batched, llm_query_chunked, map_files, "
                "rlm_query or rlm_query_batched — not llm_map_reduce, whose reduce step depends "
                "on its own map results and so cannot be a single Task"))
        # Mark every request this builder posts as detached: the parent routes them to its
        # session-scoped registry, since they may outlive the exec that started them.
        self._detached = True
        try:
            return builder(*args, **kwargs)
        except TypeError as e:
            return Task.resolved(self, "spawn", _surfaced_error(f"bad spawn arguments — {e}"))
        finally:
            self._detached = False

    def _await_task(self, task) -> Any:
        """Block until `task` has its result. Idempotent — the value is memoized."""
        if not isinstance(task, Task):
            return _surfaced_error(
                f"rlm_await expects a Task from spawn(), got {type(task).__name__}"
            )
        if not task._settled:
            self._drain_until(task._rids)
            task._value = task._reduce(self._take(task._rids))
            task._settled = True
        return task._value

    def _await_all(self, tasks) -> list:
        """Block until every task has its result. Order matches the input."""
        tasks = list(tasks)
        # One union drain so the tasks overlap instead of settling one after another.
        union: list[str] = []
        seen: set[str] = set()
        for t in tasks:
            if not isinstance(t, Task) or t._settled:
                continue
            for rid in t._rids:
                if rid not in seen:
                    seen.add(rid)
                    union.append(rid)
        if union:
            self._drain_until(union)
        return [self._await_task(t) for t in tasks]

    # ---- deterministic retrieval (no sub-LLM calls, no root tokens) -----------------------

    def _entries(self) -> list[tuple[str, str]]:
        return _context_entries(self.ns.get("context"))

    def _get_index(self) -> _Bm25Index:
        """Build the BM25 index on first use; rebuild when `context` was replaced or resized.

        Identity+length is a cheap stamp that catches the two ways context actually changes:
        load_library() extending the list, and the model re-binding the name. In-place edits
        that preserve length are not detected — documented, and rare in practice.
        """
        ctx = self.ns.get("context")
        stamp = (id(ctx), len(ctx) if isinstance(ctx, (list, str)) else 0)
        if self._index is None or self._index_stamp != stamp:
            self._index = _Bm25Index(self._entries())
            self._index_stamp = stamp
        return self._index

    def _search(self, query: str, k: int = 10, path_glob: str | None = None) -> list[dict[str, Any]]:
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
        return self._get_index().query(terms, limit, path_glob)

    def _grep_context(
        self,
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
        for path, content in self._entries():
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

    def _outline(self, path: str) -> str:
        """Definition/heading skeleton of one context file — orient in ~200 chars, not 20K.

        `path` matches exactly, then by suffix, then as a glob.
        """
        target = str(path)
        entries = self._entries()
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

    # ---- one-line delegation (structural: orchestrating must be easier than solving) -------

    def _start_map_files(self, files: Any, prompt: str, model: str | None = None) -> Task:
        """Post every batch map_files needs, WITHOUT waiting. Contract: see _map_files.

        All batches go on the wire together, so a 100-file map costs one round-trip of latency
        rather than one per 20 files.
        """
        prompt = str(prompt)
        by_path: list[tuple[str, str]] = []
        lookup: dict[str, str] | None = None
        for item in files if isinstance(files, (list, tuple)) else [files]:
            if isinstance(item, dict):
                content = item.get("content", "")
                by_path.append((str(item.get("path", "?")), content if isinstance(content, str) else str(content)))
            elif isinstance(item, str):
                if lookup is None:
                    lookup = {p: c for p, c in self._entries()}
                if item in lookup:
                    by_path.append((item, lookup[item]))
                else:
                    by_path.append((item, ""))
        if not by_path:
            return Task.resolved(self, "map_files", {})

        # Per-file prompt budget; anything larger is chunked and its answers concatenated.
        budget = self.max_prompt_chars - len(prompt) - _CHUNK_HEADER_OVERHEAD - 256
        if budget < 1_000:
            return Task.resolved(self, "map_files", {
                p: "Error: prompt too long to leave room for file content" for p, _ in by_path
            })

        requests: list[str] = []
        spans: list[tuple[str, int]] = []  # (path, number of chunks contributed)
        for path, content in by_path:
            chunks = _chunk_text(content, budget) if len(content) > budget else [content]
            spans.append((path, len(chunks)))
            for j, chunk in enumerate(chunks):
                header = f"[file {path}" + (f", part {j + 1}/{len(chunks)}]" if len(chunks) > 1 else "]")
                requests.append(f"{prompt}\n\n{header}\n{chunk}")

        rids: list[str] = []
        sizes: list[int] = []
        for i in range(0, len(requests), _MAX_CHUNK_BATCH):
            batch = requests[i:i + _MAX_CHUNK_BATCH]
            rids.append(self._post("llm_query_batched", {"prompts": batch, "model": model}))
            sizes.append(len(batch))
        return Task(self, "map_files", tuple(rids),
                    _reduce_map_files(sizes, spans), f"{len(by_path)} files")

    @_spawnable("map_files")
    def _map_files(self, files: Any, prompt: str, model: str | None = None) -> dict[str, str]:
        """Ask `prompt` of every given file, batched, and return {path: answer}.

        `files` accepts context entries (dicts), paths (strings), or a mix — the whole
        chunk/batch/collect loop the system prompt used to spell out, as one call.
        Oversized files are split and their per-chunk answers joined.
        """
        return self._await_task(self._start_map_files(files, prompt, model))

    def _llm_map_reduce(
        self,
        items: Any,
        map_prompt: str,
        reduce_prompt: str,
        model: str | None = None,
    ) -> str:
        """Map `map_prompt` over `items` in one batch, then reduce the answers with one call.

        The paper's canonical strategy ("query an LLM per chunk ... then query an LLM with all
        the buffers") as a single call, so the root never hand-rolls the loop.
        """
        map_prompt, reduce_prompt = str(map_prompt), str(reduce_prompt)
        seq = list(items) if isinstance(items, (list, tuple)) else [items]
        if not seq:
            return "Error: llm_map_reduce got no items"
        texts = [
            (str(it.get("content", "")) if isinstance(it, dict) else str(it))
            for it in seq
        ]
        labels = [
            (str(it.get("path", f"item {i + 1}")) if isinstance(it, dict) else f"item {i + 1}")
            for i, it in enumerate(seq)
        ]
        mapped: list[str] = []
        for i in range(0, len(texts), _MAX_CHUNK_BATCH):
            batch = [
                f"{map_prompt}\n\n[{labels[i + j]}]\n{t}"
                for j, t in enumerate(texts[i:i + _MAX_CHUNK_BATCH])
            ]
            mapped.extend(self._llm_query_batched(batch, model))
        joined = "\n\n".join(f"[{labels[i]}]\n{a}" for i, a in enumerate(mapped))
        return self._llm_query(f"{reduce_prompt}\n\nPartial answers:\n{joined}", model)

    # ---- sync helpers: await(start(...)), so there is exactly one code path -----------------

    @_spawnable("llm_query")
    def _llm_query(self, prompt: str, model: str | None = None) -> str:
        return self._await_task(self._start_llm_query(prompt, model))

    @_spawnable("llm_query_batched")
    def _llm_query_batched(self, prompts, model: str | None = None) -> list[str]:
        return self._await_task(self._start_llm_query_batched(prompts, model))

    @_spawnable("llm_query_chunked")
    def _llm_query_chunked(self, text, prompt: str, model: str | None = None) -> list[str]:
        return self._await_task(self._start_llm_query_chunked(text, prompt, model))

    @_spawnable("rlm_query")
    def _rlm_query(self, prompt: str, model: str | None = None, paths=None) -> str:
        return self._await_task(self._start_rlm_query(prompt, model, paths))

    def _ask_user_question(self, questions: list[dict]) -> list[dict]:
        """Present structured questions to the user; blocks until answered.

        Returns a list of {question, selected, custom?} dicts.
        Each dict has: question (str), selected (list[str]), custom (str|None).
        Only valid at root depth; sub-RLM calls return an error answer.
        """
        if self.depth > 0:
            qlist = questions if isinstance(questions, list) else []
            return [
                {"question": str(q.get("question", "")) if isinstance(q, dict) else "",
                 "selected": [],
                 "custom": "Error: ask_user_question not available inside rlm_query sub-calls"}
                for q in qlist
            ] or [{"question": "", "selected": [],
                   "custom": "Error: ask_user_question not available inside rlm_query sub-calls"}]
        if not isinstance(questions, list) or not questions:
            return [{"question": "", "selected": [], "custom": "Error: questions must be a non-empty list"}]
        cleaned = []
        for q in questions:
            if not isinstance(q, dict) or "question" not in q or "options" not in q:
                return [{"question": "", "selected": [], "custom": "Error: each question needs 'question', 'header', 'options'"}]
            opts = q.get("options")
            if not isinstance(opts, list):
                return [{"question": str(q.get("question", "")), "selected": [], "custom": "Error: options must be a list"}]
            cleaned_opts = []
            for o in opts:
                if not isinstance(o, dict) or "label" not in o:
                    return [{"question": str(q.get("question", "")), "selected": [], "custom": "Error: each option needs 'label'"}]
                item = {"label": str(o["label"]), "description": str(o.get("description", ""))}
                if "preview" in o:
                    item["preview"] = str(o["preview"])
                cleaned_opts.append(item)
            cleaned.append({
                "question": str(q["question"]),
                "header": str(q.get("header", "Q")),
                "multiSelect": bool(q.get("multiSelect", False)),
                "options": cleaned_opts,
            })
        r = self._rpc("ask_user_question", {"questions": cleaned})
        if r.get("error"):
            return [{"question": q["question"], "selected": [], "custom": f"Error: {r['error']}"} for q in cleaned]
        answers = r.get("answers", [])
        return answers if isinstance(answers, list) else []

    def _todo(self, action: str, **kwargs) -> str:
        """Manage the run's task list.

        action: "create" | "update" | "list" | "get" | "delete" | "clear"
        kwargs: id, subject, description, status, activeForm, blockedBy, owner, filterStatus
        Returns a human-readable string result.
        """
        params = {k: v for k, v in kwargs.items() if v is not None}
        r = self._rpc("todo", {"action": str(action), **params})
        if r.get("error"):
            return f"Error: {r['error']}"
        return str(r.get("response", "ok"))

    def _load_library(self, source: str) -> dict[str, Any] | str:
        """Pack an external dir/file/git-URL on the host and append it into `context`.

        Paths are namespaced under lib/<source_id>/ (host). Content is always in the
        single `context` list — never a new context_N variable.
        Host-side idempotency may return already_loaded without a payload path.
        """
        r = self._rpc("load_library", {"source": str(source)})
        if r.get("error"):
            return f"Error: {r['error']}"
        if r.get("already_loaded"):
            source_id = r.get("source_id") if isinstance(r.get("source_id"), str) else "lib"
            path_prefix = r.get("path_prefix") if isinstance(r.get("path_prefix"), str) else f"lib/{source_id}/"
            ctx = self.ns.get("context")
            ctx_len = len(ctx) if isinstance(ctx, list) else 0
            print(
                f"[rlm] load_library: already loaded {source_id} "
                f"(paths under {path_prefix}, context len={ctx_len})"
            )
            return {
                "source": str(source),
                "source_id": source_id,
                "path_prefix": path_prefix,
                "files": 0,
                "chars": r.get("chars"),
                "context_len": ctx_len,
                "already_loaded": True,
            }
        path = r.get("path")
        if not isinstance(path, str):
            return "Error: malformed load_library reply (no path)"
        try:
            # Worker-internal read — use real io.open so read-only guards never block us.
            with _REAL_IO_OPEN(path, "r") as f:
                payload = json.load(f) if r.get("json") else f.read()
        finally:
            try:
                os.remove(path)  # worker owns temp-file cleanup (host does NOT unlink)
            except OSError:
                pass
        return self._append_library(str(source), payload, r)

    def _append_library(self, source: str, payload: Any, meta: dict[str, Any]) -> dict[str, Any] | str:
        """Append host-packed library files into `context` (idempotent by path prefix).

        The two refusals below are pre-flighted host-side by LIST_CONTEXT_REQUIRED /
        NO_FILES_PRODUCED in src/bridge/library.ts, so the host never commits a sidecar index or
        loaded-prefix for an append that fails here. Reaching either one means host and worker
        disagree about `context`; keep the wording identical to its twin.
        """
        ctx = self.ns.get("context")
        if not isinstance(ctx, list):
            kind = type(ctx).__name__ if ctx is not None else "None"
            return f"Error: load_library requires list context (file bundle); got {kind}"

        source_id = meta.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            source_id = "lib"
        path_prefix = meta.get("path_prefix")
        if not isinstance(path_prefix, str) or not path_prefix:
            path_prefix = f"lib/{source_id}/"

        # Idempotent: already present if any path uses this library prefix.
        for item in ctx:
            if isinstance(item, dict) and str(item.get("path", "")).startswith(path_prefix):
                print(
                    f"[rlm] load_library: already loaded {source_id} "
                    f"(paths under {path_prefix}, context len={len(ctx)})"
                )
                return {
                    "source": source,
                    "source_id": source_id,
                    "path_prefix": path_prefix,
                    "files": 0,
                    "chars": meta.get("chars"),
                    "context_len": len(ctx),
                    "already_loaded": True,
                }

        files = self._library_file_entries(payload, path_prefix)
        if not files:
            return "Error: load_library produced no files"

        ctx.extend(files)
        # Keep restore payload in sync with the live list.
        self._context_payload = ctx
        self.ns["context"] = ctx

        print(
            f"[rlm] load_library: +{len(files)} files into context "
            f"(len={len(ctx)}); paths under {path_prefix}"
        )
        return {
            "source": source,
            "source_id": source_id,
            "path_prefix": path_prefix,
            "files": len(files),
            "chars": meta.get("chars"),
            "context_len": len(ctx),
            "already_loaded": False,
        }

    @staticmethod
    def _library_file_entries(payload: Any, path_prefix: str) -> list[dict[str, Any]]:
        """Normalize host payload to list[dict]. Host already namespaces; string is fallback."""
        if isinstance(payload, str):
            return [{
                "path": f"{path_prefix}content",
                "content": payload,
                "tokens": max(1, (len(payload) + 3) // 4),
            }]
        if not isinstance(payload, list):
            return []
        out: list[dict[str, Any]] = []
        for item in payload:
            if isinstance(item, dict) and "path" in item and "content" in item:
                out.append(item)
        return out

    def _advance_phase(self, phase: str, summary: str | None = None) -> str:
        """Transition the root RLM pipeline to a new phase.

        Only callable at depth 0. The parent handler validates the transition
        against the phase state machine (research → blueprint → validate)
        and runs deterministic artifact gates before accepting the transition.
        Returns a short confirmation, or an `Error: …` string the model can act on.
        """
        if self.depth > 0:
            return "Error: advance_phase is only available at the root RLM depth"
        r = self._rpc("advance_phase", {"phase": str(phase), "summary": summary})
        if r.get("error"):
            return f"Error: {r['error']}"
        response = r.get("response", "ok")
        if isinstance(response, str) and response.startswith("Error:"):
            return response
        return response if isinstance(response, str) else "ok"

    def _save_artifact(self, kind: str, content: str) -> str:
        """Persist a stage artifact (research/plan/validation) under .rlm/artifacts/.

        Only callable at depth 0. The engine gates advance_phase against the latest
        saved artifact for the current stage.
        """
        if self.depth > 0:
            return "Error: save_artifact is only available at the root RLM depth"
        r = self._rpc("save_artifact", {"artifactKind": str(kind), "content": str(content)})
        if r.get("error"):
            return f"Error: {r['error']}"
        response = r.get("response", "ok")
        if isinstance(response, str) and response.startswith("Error:"):
            return response
        return response if isinstance(response, str) else "ok"

    @_spawnable("rlm_query_batched")
    def _rlm_query_batched(self, prompts, model: str | None = None, paths=None) -> list[str]:
        return self._await_task(self._start_rlm_query_batched(prompts, model, paths))

    # ---- context + execution --------------------------------------------------------------

    def load_context(self, path: str, index: int | None = None, is_json: bool = False) -> int:
        """Load the packed world into the single REPL variable `context`.

        `index` is accepted for protocol compatibility but ignored — there is only
        one context slot. Libraries are merged on the host (or via load_library).
        """
        with open(path, "r") as f:
            payload = json.load(f) if is_json else f.read()
        self._context_payload = payload
        self.ns["context"] = payload
        # Drop legacy multi-slot names if present.
        for k in list(self.ns.keys()):
            if k != "context" and _CONTEXT_NAME.match(k):
                del self.ns[k]
        return 0

    @contextmanager
    def _capture(self):
        out, err = io.StringIO(), io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            yield out, err
        finally:
            sys.stdout, sys.stderr = old_out, old_err

    def _exec(self, code: str, ns: dict[str, Any]) -> None:
        t = self.exec_timeout_s
        if t <= 0 or not hasattr(signal, "SIGALRM"):
            exec(compile(code, "<repl>", "exec"), ns, ns)  # noqa: S102
            return

        def _alarm(signum, frame):  # noqa: ARG001
            raise TimeoutError(f"```repl``` block exceeded {t:g}s timeout")

        old = signal.signal(signal.SIGALRM, _alarm)
        signal.setitimer(signal.ITIMER_REAL, t)
        try:
            exec(compile(code, "<repl>", "exec"), ns, ns)  # noqa: S102
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)

    def _nudge_lines(self) -> list[str]:
        """One-time hint for newly created huge raw-text variables (single line).

        Collapses to one line so it survives headless stdout elision (head 200 + tail 200).
        """
        names: list[str] = []
        for k in self._user_var_names():
            v = self.ns.get(k)
            if isinstance(v, (str, bytes)) and len(v) > _NUDGE_CHARS and k not in self._nudged:
                self._nudged.add(k)
                names.append(f"{k} ({len(v):,} chars)")
        if not names:
            return []
        return [
            f"[rlm] huge raw-text variable(s): {', '.join(names)} — do NOT analyze them yourself; "
            'delegate with llm_query_chunked(name, "your question") or slice + llm_query_batched.'
        ]

    def execute(self, code: str) -> dict[str, Any]:
        start = time.perf_counter()
        raised = False
        with self._capture() as (out, err):
            try:
                self._restore_scaffold()
                self._exec(code, self.ns)
                self._restore_scaffold()
                stdout, stderr = out.getvalue(), err.getvalue()
            except BaseException as e:  # noqa: BLE001
                raised = True
                self._restore_scaffold()
                stdout = out.getvalue()
                stderr = err.getvalue() + f"\n{type(e).__name__}: {e}\n" + traceback.format_exc()
        final, self._final_answer = self._final_answer, None
        answer = self.ns.get("answer")
        answer_content = answer.get("content", "") if isinstance(answer, dict) else ""
        # ready may have been flipped with empty content before content was assigned later
        # in the same block; the dict's current content is the real submission.
        if final is not None and not final.strip() and str(answer_content).strip():
            final = str(answer_content)
        nudges = self._nudge_lines()
        if nudges:
            parts = [stdout] if stdout else []
            parts.extend(nudges)
            stdout = "\n".join(parts) + "\n"
        return {
            "stdout": stdout,
            "stderr": stderr,
            "final_answer": final,
            "answer_content": str(answer_content),
            "raised": raised,
            "execution_time": time.perf_counter() - start,
            "var_names": self._user_var_names(),
        }

    def _serializer(self):
        try:
            import dill as s
            return s
        except ImportError:
            return pickle

    def snapshot(self, path: str, nonce: str) -> dict:
        """Pickle user variables atomically to path. Stores session nonce for restore verification.

        Writes to path.tmp then os.rename — atomic on POSIX, so no .tmp leak and no
        TypeScript-side finalize step needed. On resume (fresh session = different nonce),
        restore fails — caller falls back to history-only replay.
        """
        s = self._serializer()
        out, skipped = {}, []
        MAX_VAR_BYTES = 50 * 1024 * 1024
        for k, v in self.ns.items():
            if k.startswith("_") or _CONTEXT_NAME.match(k) or k in RESERVED or k == "__builtins__":
                continue
            # A Task holds a back-reference to this Worker, so dill would happily pickle the
            # whole process. Top-level guard only: a Task nested inside a list/dict still
            # falls to the generic `except` below and skips the variable — which is why this
            # guard is explicit rather than left to that fallback.
            if isinstance(v, Task):
                skipped.append(k)
                continue
            try:
                blob = s.dumps(v)
                if len(blob) > MAX_VAR_BYTES:
                    skipped.append(k)
                    continue
                out[k] = v
            except Exception:
                skipped.append(k)
        if skipped:
            print(f"[rlm-sandbox] snapshot skipped {len(skipped)} unpicklable/oversized vars: {skipped}", file=_REAL_STDERR)
        tmp = path + ".tmp"
        with _REAL_IO_OPEN(tmp, "wb") as f:
            s.dump({"nonce": nonce, "vars": out}, f)
        os.rename(tmp, path)  # atomic rename
        return {"skipped": skipped}

    def restore(self, path: str, nonce: str) -> dict:
        """Restore user variables from a pickle file. Verifies session nonce before deserializing.

        SECURITY: pickle.load executes arbitrary code. The session nonce check ensures the
        .pkl was written by THIS engine session. Cross-session resume falls back to
        history-only replay (caller skips restore when sessionNonce is undefined).
        """
        s = self._serializer()
        with _REAL_IO_OPEN(path, "rb") as f:
            data = s.load(f)
        if not isinstance(data, dict) or data.get("nonce") != nonce:
            raise ValueError("snapshot nonce mismatch — not from this session")
        self.ns.update(data.get("vars", {}))
        self._restore_scaffold()
        return {"restored": list(data.get("vars", {}).keys())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=int(os.environ.get("RLM_DEPTH", "1")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("RLM_EXEC_TIMEOUT_S", "600")))
    ap.add_argument("--await-timeout", type=float,
                    default=float(os.environ.get("RLM_AWAIT_TIMEOUT_S", "600")))
    ap.add_argument("--max-prompt-chars", type=int,
                    default=int(os.environ.get("RLM_MAX_PROMPT_CHARS", "400000")))
    ap.add_argument("--read-only", action="store_true",
                    default=os.environ.get("RLM_READ_ONLY", "").lower() in ("1", "true", "yes"),
                    help="Reject open() write modes (pipeline runs)")
    args = ap.parse_args()

    worker = Worker(depth=args.depth, exec_timeout_s=args.timeout,
                    max_prompt_chars=args.max_prompt_chars, read_only=args.read_only,
                    await_timeout_s=args.await_timeout)
    _send({"id": "_init", "ok": True})

    while True:
        # Requests that arrived mid-exec were parked by _pump; replay them before reading.
        req = worker.take_deferred()
        if req is None:
            line = _REAL_STDIN.readline()
            if not line:
                return
            raw = line.strip()
            if not raw:
                continue
            try:
                req = json.loads(raw)
            except json.JSONDecodeError as e:
                _send({"id": "?", "ok": False, "error": f"bad json: {e}"})
                continue
        # A task spawned in an earlier exec settling while the worker is idle. Park it for
        # a later rlm_await; without this it would fall through to "unknown type" and the
        # result would be lost.
        if worker.park_reply(req):
            continue
        if not isinstance(req, dict):
            _send({"id": "?", "ok": False, "error": f"expected an object, got {type(req).__name__}"})
            continue
        rid, kind = req.get("id", "?"), req.get("type")
        try:
            if kind == "exec":
                _send({"id": rid, "ok": True, **worker.execute(req.get("code", ""))})
            elif kind == "load_context":
                idx = worker.load_context(req.get("path"), req.get("index"), req.get("json"))
                _send({"id": rid, "ok": True, "index": idx})
            elif kind == "shutdown":
                _send({"id": rid, "ok": True})
                return
            elif kind == "snapshot":
                _send({"id": rid, "ok": True, **worker.snapshot(req.get("path", ""), req.get("nonce", ""))})
            elif kind == "restore":
                _send({"id": rid, "ok": True, **worker.restore(req.get("path", ""), req.get("nonce", ""))})
            else:
                _send({"id": rid, "ok": False, "error": f"unknown type: {kind!r}"})
        except BaseException as e:  # noqa: BLE001
            _send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"})


if __name__ == "__main__":
    main()
