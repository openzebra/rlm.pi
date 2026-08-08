"""Async sub-call plumbing: the `Task` handle, the spawn allow-list, and the reply reducers.

A request and its reply are decoupled — `_post` returns a rid without waiting and replies are
parked by rid — so a Task started in one exec can be awaited in a later one. Each kind of
sub-call knows how to fold its parked replies back into a result; that is what a reducer is.
"""

from __future__ import annotations

from typing import Any


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
