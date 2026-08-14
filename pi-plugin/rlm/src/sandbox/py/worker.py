"""RLM sandbox worker: a persistent Python REPL driven over a JSONL stdio protocol.

Executes model-authored Python with secrets stripped from the environment.
This is NOT a security sandbox: __import__ and open are available, so code can import networking modules
(socket, urllib, subprocess) and read/write local files. Trust the root model's code.

Protocol (parent -> worker):  {"id","type":"exec"|"load_context"|"shutdown", ...}
Protocol (worker -> parent):  {"id","ok",...result}            # response to a request
                              {"type":"llm_query"|"llm_batch"|"rlm_query"|
                               "rlm_batch"|"add_context","rid",...}
                                                                # mid-exec helper request
When sandbox code calls llm_query/rlm_query/add_context, the worker writes a
request line and BLOCKS reading stdin until the matching {"type":"llm_reply","rid",...} arrives.
The parent services the request in-process (it holds API keys).

Requests and replies are decoupled: `_post` writes a request and returns its rid without
waiting, and replies are parked in `_inbox` keyed by rid until something asks for them. That
is what makes `spawn()` / `await_task()` / `await_task()` possible — many requests can be
in flight at once (the parent already services interrupts concurrently), and a task may be
awaited in a LATER exec than the one that started it.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import signal
import sys
import time
import traceback
from contextlib import contextmanager
from typing import Any

# Sibling modules: Python puts this file's directory on sys.path[0], so these resolve without
# any packaging step. They ship inside `src/` like everything else.
from guards import (
    _SAFE_BUILTINS,
    _CONTEXT_NAME,
    _send,
    _stall_alarm,
    _surfaced_error,
    RESERVED,
    REAL_STDERR as _REAL_STDERR,
    REAL_STDIN as _REAL_STDIN,
)
from hostio import read_host_payload
from retrieval import (
    _Bm25Index,
    _chunk_text,
    _context_entries,
    _CHUNK_HEADER_OVERHEAD,
    _MAX_CHUNK_BATCH,
    _MAX_CHUNKS,
    _NUDGE_CHARS,
    grep_context as _grep_context_impl,
    outline as _outline_impl,
    search as _search_impl,
)
from tasks import (
    _clean_paths,
    _reduce_batch,
    _reduce_chunked,
    _reduce_map_files,
    _reduce_one,
    _spawnable,
    Task,
)

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



class Worker:
    def __init__(
        self,
        depth: int,
        exec_timeout_s: float,
        max_prompt_chars: int,
        await_timeout_s: float = 600.0,
    ):
        self.depth = depth
        self.exec_timeout_s = exec_timeout_s
        self.max_prompt_chars = max_prompt_chars
        self.await_timeout_s = await_timeout_s
        self._rid = 0
        self._final_answer: str | None = None
        # Replies parked by rid until something awaits them. Unbounded by design: a task
        # the model spawns and never awaits keeps its entry for the life of the process.
        # Bounded in practice by session length; evicting would silently hang a later
        # await_task, which is strictly worse than the memory.
        self.inbox: dict[str, dict[str, Any]] = {}
        self._inflight: set[str] = set()
        # Requests (exec/shutdown) that arrived mid-exec; main() replays them.
        self._deferred: list[Any] = []
        # Kept for spawn() compatibility; sub-LLM kinds always post detached=true so fan-out
        # outlives the repl cell and shows ↯bg (see _post).
        self._detached = False
        self.ns: dict[str, Any] = {}
        self._setup()

    def _setup(self) -> None:
        builtins = _SAFE_BUILTINS.copy()
        builtins["open"] = open
        self.ns = {"__builtins__": builtins, "__name__": "__main__"}
        self._context_payload: Any = []  # empty list — the only starting value that needs no bootstrap branch
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
        ns["llm_batch"] = self._llm_batch
        ns["llm_query_chunked"] = self._llm_query_chunked
        ns["rlm_query"] = self._rlm_query
        ns["rlm_batch"] = self._rlm_batch
        ns["spawn"] = self._spawn
        # One collect API: await_task(Task) or await_task([Task, ...])
        ns["await_task"] = self._await_task
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
        ns["add_context"] = self._add_context
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
        # name entirely; mutations and re-binds persist within the run. Always a list.
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

    # Sub-LLM fan-out always runs detached (session BG registry + ↯bg), whether called
    # as llm_batch(...) or via map_files internals — not only when wrapped in spawn().
    _DETACHED_KINDS = frozenset({"llm_query", "llm_batch", "rlm_query", "rlm_batch"})

    def _post(self, kind: str, payload: dict[str, Any]) -> str:
        """Write one parent request and return its rid WITHOUT waiting for the reply."""
        self._rid += 1
        rid = f"q{self._rid}"
        # Register only after the write succeeds — a broken pipe must not leave an
        # _inflight entry that nothing will ever settle.
        detached = self._detached or kind in self._DETACHED_KINDS
        _send({"type": kind, "rid": rid, "depth": self.depth,
               "detached": detached, **payload})
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
        # A request (exec/shutdown) arriving mid-exec: main() replays it.
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

    def _start_prompt(self, kind: str, prompt, paths=None) -> Task:
        text = str(prompt)
        # A sub-LLM asked nothing answers something: the confabulation then sits in `answers`
        # looking exactly like data. Refuse instead of spending a call on it.
        if not text.strip():
            return Task.resolved(self, kind, _surfaced_error(
                f"{kind}() got an empty prompt — a sub-LLM would confabulate an answer to nothing"))
        payload: dict[str, Any] = {"prompt": text}
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return Task(self, kind, (rid,), _reduce_one, text[:40])

    def _start_prompts(self, kind: str, prompts, paths=None) -> Task:
        prompts = [str(p) for p in prompts]
        if not prompts:
            return Task.resolved(self, kind, [])
        # Only the all-blank case: one blank prompt among twenty is the caller's business.
        if not any(p.strip() for p in prompts):
            return Task.resolved(self, kind, [
                _surfaced_error(f"{kind}() got only empty prompts")
            ] * len(prompts))
        payload: dict[str, Any] = {"prompts": prompts}
        # One prefix set for the whole batch: a per-prompt aligned list is an API nobody uses
        # correctly, and every prompt in a batch is asking about the same slice anyway.
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return Task(self, kind, (rid,), _reduce_batch(len(prompts)), f"×{len(prompts)}")

    def _start_llm_query(self, prompt) -> Task:
        return self._start_prompt("llm_query", prompt)

    def _start_rlm_query(self, prompt, paths=None) -> Task:
        return self._start_prompt("rlm_query", prompt, paths)

    def _start_llm_batch(self, prompts) -> Task:
        return self._start_prompts("llm_batch", prompts)

    def _start_rlm_batch(self, prompts, paths=None) -> Task:
        return self._start_prompts("rlm_batch", prompts, paths)

    def _start_llm_query_chunked(self, text, prompt: str) -> Task:
        """Split oversized text into cap-sized chunks and post EVERY batch at once.

        One answer per chunk, order preserved. No exceptions escape: errors come back as
        "Error: ..." strings per chunk (same contract as llm_batch). Because all
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
            rids.append(self._post("llm_batch", {"prompts": batch}))
            sizes.append(len(batch))
        return Task(self, "llm_query_chunked", tuple(rids), _reduce_chunked(sizes), f"{total} chunks")
    def _builder_for(self, name: str):
        # llm_map_reduce is deliberately absent: its reduce step is a SECOND sub-LLM call that
        # depends on its own map results, so it cannot be one (rids, pure reduce) Task.
        return {
            "llm_query": self._start_llm_query,
            "llm_batch": self._start_llm_batch,
            "llm_query_chunked": self._start_llm_query_chunked,
            "map_files": self._start_map_files,
            "rlm_query": self._start_rlm_query,
            "rlm_batch": self._start_rlm_batch,
        }.get(name)

    def _spawn(self, fn, *args, **kwargs) -> Task:
        """Start a sub-call without waiting for it. `fn` is the scaffold function itself.

        Returns a Task for await_task, possibly in a later ```repl``` block.
        Misuse returns an already-resolved error Task rather than raising, matching the
        "Error: ..." contract of the synchronous helpers.
        """
        name = getattr(fn, "_rlm_name", None)
        builder = self._builder_for(name) if isinstance(name, str) else None
        if builder is None:
            return Task.resolved(self, "spawn", _surfaced_error(
                "spawn() takes llm_query, llm_batch, llm_query_chunked, map_files, "
                "rlm_query or rlm_batch — not llm_map_reduce, whose reduce step depends "
                "on its own map results and so cannot be a single Task"))
        # Sub-LLM kinds already post detached via _post; keep the flag for clarity / future kinds.
        self._detached = True
        try:
            return builder(*args, **kwargs)
        except TypeError as e:
            return Task.resolved(self, "spawn", _surfaced_error(f"bad spawn arguments — {e}"))
        finally:
            self._detached = False

    def _await_one(self, task: Task) -> Any:
        """Block until one Task has its result. Idempotent — the value is memoized."""
        if not task._settled:
            self._drain_until(task._rids)
            task._value = task._reduce(self._take(task._rids))
            task._settled = True
        return task._value

    def _await_task(self, task_or_tasks) -> Any:
        """Collect result(s). Accepts a single Task or a list/tuple of Tasks.

        Canonical name for the model: await_task(...). (bare `await` is a Python keyword.)
        """
        if isinstance(task_or_tasks, Task):
            return self._await_one(task_or_tasks)
        if isinstance(task_or_tasks, (list, tuple)):
            tasks = list(task_or_tasks)
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
            out: list[Any] = []
            for t in tasks:
                if isinstance(t, Task):
                    out.append(self._await_one(t))
                else:
                    out.append(
                        _surfaced_error(
                            f"await_task expects Task items, got {type(t).__name__}"
                        )
                    )
            return out
        return _surfaced_error(
            f"await_task expects a Task or list of Tasks, got {type(task_or_tasks).__name__}"
        )

    # ---- deterministic retrieval (no sub-LLM calls, no root tokens) -----------------------

    def _entries(self) -> list[tuple[str, str]]:
        return _context_entries(self.ns.get("context"))

    def _get_index(self) -> _Bm25Index:
        """Build the BM25 index on first use; rebuild when `context` was replaced or resized.

        Identity+length is a cheap stamp that catches the two ways context actually changes:
        add_context() extending the list, and the model re-binding the name. In-place edits
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

        Returns [{path, line, score, snippet}] — pointers, not bodies.
        """
        return _search_impl(self._entries(), self._get_index(), query, k, path_glob)

    def _grep_context(
        self,
        pattern: str,
        k: int = 50,
        path_glob: str | None = None,
        before: int = 0,
        after: int = 0,
    ) -> dict[str, Any]:
        """Regex over `context`, capped and shaped. See retrieval.grep_context."""
        return _grep_context_impl(self._entries(), pattern, k, path_glob, before, after)

    def _outline(self, path: str) -> str:
        """Definition/heading skeleton of one context file. See retrieval.outline."""
        return _outline_impl(self._entries(), path)

    # ---- one-line delegation (structural: orchestrating must be easier than solving) -------

    def _start_map_files(self, files: Any, prompt: str) -> Task:
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
            rids.append(self._post("llm_batch", {"prompts": batch}))
            sizes.append(len(batch))
        return Task(self, "map_files", tuple(rids),
                    _reduce_map_files(sizes, spans), f"{len(by_path)} files")

    @_spawnable("map_files")
    def _map_files(self, files: Any, prompt: str) -> Task:
        """Always spawn. Collect with await_task(t) → dict[path, answer].

        `files` accepts context entries (dicts), paths (strings), or a mix — the whole
        chunk/batch/collect loop the system prompt used to spell out, as one call.
        Oversized files are split and their per-chunk answers joined.
        Posts are detached (↯bg) so fan-out outlives the repl cell.
        """
        return self._start_map_files(files, prompt)

    def _llm_map_reduce(
        self,
        items: Any,
        map_prompt: str,
        reduce_prompt: str,
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
            # Core tools always return Task — helpers must await explicitly.
            part = self._await_task(self._start_llm_batch(batch))
            mapped.extend(part if isinstance(part, list) else [str(part)])
        joined = "\n\n".join(f"[{labels[i]}]\n{a}" for i, a in enumerate(mapped))
        reduced = self._await_task(
            self._start_llm_query(f"{reduce_prompt}\n\nPartial answers:\n{joined}")
        )
        return str(reduced)

    # ---- Core tools: ALWAYS spawn (return Task). Collect with await_task only. ------------

    @_spawnable("llm_query")
    def _llm_query(self, prompt: str) -> Task:
        """Always spawn. Collect with await_task(t). Never auto-awaits."""
        return self._start_llm_query(prompt)

    @_spawnable("llm_batch")
    def _llm_batch(self, prompts) -> Task:
        """Always spawn. Collect with await_task(t) → ordered list[str]."""
        return self._start_llm_batch(prompts)

    @_spawnable("llm_query_chunked")
    def _llm_query_chunked(self, text, prompt: str) -> Task:
        """Always spawn. Collect with await_task(t) → list[str] (one answer per chunk)."""
        return self._start_llm_query_chunked(text, prompt)

    @_spawnable("rlm_query")
    def _rlm_query(self, prompt=None, task=None, paths=None) -> Task:
        """Always spawn. Collect with await_task(t). Accepts `task=` or `prompt=` (same string)."""
        p = prompt if prompt is not None else task
        if not isinstance(p, str) or not p.strip():
            raise TypeError(
                "rlm_query() needs the study text: rlm_query(task='…', paths=[…]) "
                "or positionally rlm_query('…', paths=[…])"
            )
        return self._start_rlm_query(p, paths)

    def _add_context(self, source: str) -> dict[str, Any] | str:
        """Pack an external dir/file/git-URL on the host and append it into `context`.

        Paths are namespaced under ctx/<source_id>/ (host). Content is always in the
        single `context` list — never a new context_N variable.
        Host-side idempotency may return already_loaded without a payload path.
        Documents (PDF/DOCX/…) are converted to Markdown on the host.
        """
        r = self._rpc("add_context", {"source": str(source)})
        if r.get("error"):
            return f"Error: {r['error']}"
        if r.get("already_loaded"):
            source_id = r.get("source_id") if isinstance(r.get("source_id"), str) else "ctx"
            path_prefix = r.get("path_prefix") if isinstance(r.get("path_prefix"), str) else f"ctx/{source_id}/"
            ctx = self.ns.get("context")
            ctx_len = len(ctx) if isinstance(ctx, list) else 0
            print(
                f"[rlm] add_context: already loaded {source_id} "
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
                "documents": 0,
                "converted": 0,
                "skipped": [],
            }
        path = r.get("path")
        if not isinstance(path, str):
            return "Error: malformed add_context reply (no path)"
        try:
            payload = read_host_payload(path, bool(r.get("json")))
        finally:
            try:
                os.remove(path)  # worker owns temp-file cleanup (host does NOT unlink)
            except OSError:
                pass
        return self._append_context(str(source), payload, r)

    def _append_context(self, source: str, payload: Any, meta: dict[str, Any]) -> dict[str, Any] | str:
        """Append host-packed files into `context` (idempotent by path prefix).

        The two refusals below are pre-flighted host-side by LIST_CONTEXT_REQUIRED /
        NO_FILES_PRODUCED in src/bridge/add-context.ts, so the host never commits a
        loaded-prefix for an append that fails here. Reaching either one means host and worker
        disagree about `context`; keep the wording identical to its twin.
        """
        ctx = self.ns.get("context")
        if not isinstance(ctx, list):
            kind = type(ctx).__name__ if ctx is not None else "None"
            return f"Error: add_context requires list context (file bundle); got {kind}"

        source_id = meta.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            source_id = "ctx"
        path_prefix = meta.get("path_prefix")
        if not isinstance(path_prefix, str):
            path_prefix = f"ctx/{source_id}/"
        # Empty path_prefix is valid (cwd seed) but add_context always sends a non-empty ctx/ prefix.
        # Guard startsWith on empty prefix: "anything".startswith("") is always True.
        check_prefix = path_prefix if path_prefix != "" else None

        # Idempotent: already present if any path uses this prefix.
        if check_prefix is not None:
            for item in ctx:
                if isinstance(item, dict) and str(item.get("path", "")).startswith(check_prefix):
                    print(
                        f"[rlm] add_context: already loaded {source_id} "
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
                        "documents": 0,
                        "converted": 0,
                        "skipped": [],
                    }

        files = self._context_file_entries(payload, path_prefix)
        if not files:
            return "Error: add_context produced no files"

        ctx.extend(files)
        # Keep restore payload in sync with the live list.
        self._context_payload = ctx
        self.ns["context"] = ctx

        documents = meta.get("documents") if isinstance(meta.get("documents"), int) else 0
        converted = meta.get("converted") if isinstance(meta.get("converted"), int) else 0
        skipped = meta.get("skipped") if isinstance(meta.get("skipped"), list) else []
        skip_n = len(skipped)
        extra = ""
        if documents or converted or skip_n:
            extra = f"; documents={documents}, converted={converted}, skipped={skip_n}"
        print(
            f"[rlm] add_context: +{len(files)} files into context "
            f"(len={len(ctx)}); paths under {path_prefix}{extra}"
        )
        return {
            "source": source,
            "source_id": source_id,
            "path_prefix": path_prefix,
            "files": len(files),
            "chars": meta.get("chars"),
            "context_len": len(ctx),
            "already_loaded": False,
            "documents": documents,
            "converted": converted,
            "skipped": skipped,
        }

    @staticmethod
    def _context_file_entries(payload: Any, path_prefix: str) -> list[dict[str, Any]]:
        """Normalize host payload to list[dict]. Host already namespaces; string is fallback."""
        if isinstance(payload, str):
            return [{
                "path": f"{path_prefix}content" if path_prefix else "content",
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

    @_spawnable("rlm_batch")
    def _rlm_batch(self, prompts=None, tasks=None, paths=None) -> Task:
        """Always spawn. Collect with await_task(t) → ordered list of reports.

        Accepts `tasks=` or `prompts=` (same list) — the docs say `tasks`, legacy calls say `prompts`.
        """
        p = prompts if prompts is not None else tasks
        if not isinstance(p, (list, tuple)) or len(p) == 0:
            raise TypeError(
                "rlm_batch() needs a non-empty list of studies: rlm_batch(tasks=['…','…'], paths=[…])"
            )
        return self._start_rlm_batch(list(p), paths)

    # ---- context + execution --------------------------------------------------------------

    def load_context(self, path: str, index: int | None = None, is_json: bool = False) -> int:
        """Load the packed world into the single REPL variable `context`.

        `index` is accepted for protocol compatibility but ignored — there is only
        one context slot. Sources are merged on the host (or via add_context).
        """
        payload = read_host_payload(path, bool(is_json))
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
            'delegate with llm_query_chunked(name, "your question") or slice + llm_batch.'
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=int(os.environ.get("RLM_DEPTH", "1")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("RLM_EXEC_TIMEOUT_S", "600")))
    ap.add_argument("--await-timeout", type=float,
                    default=float(os.environ.get("RLM_AWAIT_TIMEOUT_S", "600")))
    ap.add_argument("--max-prompt-chars", type=int,
                    default=int(os.environ.get("RLM_MAX_PROMPT_CHARS", "400000")))
    args = ap.parse_args()

    worker = Worker(depth=args.depth, exec_timeout_s=args.timeout,
                    max_prompt_chars=args.max_prompt_chars,
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
        # a later await_task; without this it would fall through to "unknown type" and the
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
            else:
                _send({"id": rid, "ok": False, "error": f"unknown type: {kind!r}"})
        except BaseException as e:  # noqa: BLE001
            _send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"})


if __name__ == "__main__":
    main()
