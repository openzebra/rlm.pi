"""RLM worker scaffold — the REPL surface exposed to the model.

Pure move out of worker.py (Phase 0 of the v5 port): every method the model can call —
sub-LLM spawns, await/collect, retrieval (search/grep_context/outline), map_files,
llm_map_reduce, and add_context — lives on this mixin. worker.py keeps the protocol
machinery (stdin/stdout pump, inbox, exec loop) and mixes this in via `Worker(WorkerScaffold)`.

Sibling module: Python puts this file's directory on sys.path[0], so the import resolves
without any packaging step (same mechanism as guards.py / retrieval.py / tasks.py).
"""
from __future__ import annotations

import os
from typing import Any

from guards import _stall_message, _surfaced_error
from hostio import read_host_payload
from retrieval import (
    _Bm25Index,
    _chunk_text,
    _context_entries,
    _CHUNK_HEADER_OVERHEAD,
    _MAX_CHUNK_BATCH,
    _MAX_CHUNKS,
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


class _MemoryApi:
    """v5 durable memory surface — thin shims over the `memory` interrupt.

    memory.query(q, k=8) → retrieved notes; memory.add(text, paths=…, tags=…) → status;
    memory.stats() → store counters. All calls block on the host RPC like add_context does.
    """

    def __init__(self, worker: "WorkerScaffold"):
        self._w = worker

    def query(self, q, k: int = 8) -> str:
        return self._w._memory_rpc("query", {"query": str(q), "k": int(k)})

    def add(self, text, paths=None, tags=None) -> str:
        p = [str(x) for x in (paths or [])]
        t = [str(x) for x in (tags or [])]
        return self._w._memory_rpc("add", {"content": str(text), "paths": p, "tags": t})

    def stats(self) -> str:
        return self._w._memory_rpc("stats", {})


class WorkerScaffold:
    """Mixin: the model-facing REPL API. Requires the host methods from Worker
    (`_post`, `_rpc`, `_drain_until`, `_take`, `self.inbox`, `self.ns`, `self._handles`)."""


    # ---- spawn / await ---------------------------------------------------------------------

    def _start_prompt(self, kind: str, prompt, paths=None) -> Task:
        text = str(prompt)
        # A sub-LLM asked nothing answers something: the confabulation then sits in `answers`
        # looking exactly like data. Refuse instead of spending a call on it.
        if not text.strip():
            return self._resolved(kind, _surfaced_error(
                f"{kind}() got an empty prompt — a sub-LLM would confabulate an answer to nothing"))
        payload: dict[str, Any] = {"prompt": text}
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return self._task(kind, (rid,), _reduce_one, text[:40])

    def _start_prompts(self, kind: str, prompts, paths=None) -> Task:
        prompts = [str(p) for p in prompts]
        if not prompts:
            return self._resolved(kind, [])
        # Only the all-blank case: one blank prompt among twenty is the caller's business.
        if not any(p.strip() for p in prompts):
            return self._resolved(kind, [
                _surfaced_error(f"{kind}() got only empty prompts")
            ] * len(prompts))
        payload: dict[str, Any] = {"prompts": prompts}
        # One prefix set for the whole batch: a per-prompt aligned list is an API nobody uses
        # correctly, and every prompt in a batch is asking about the same slice anyway.
        clean = _clean_paths(paths)
        if clean is not None:
            payload["paths"] = clean
        rid = self._post(kind, payload)
        return self._task(kind, (rid,), _reduce_batch(len(prompts)), f"×{len(prompts)}")

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
            return self._resolved("llm_query_chunked", [])
        budget = self.max_prompt_chars - len(prompt) - _CHUNK_HEADER_OVERHEAD
        if budget < 1_000:
            return self._resolved("llm_query_chunked", [
                f"Error: prompt leaves under 1,000 chars per chunk (cap {self.max_prompt_chars:,}) — shorten the instruction"
            ])
        chunks = _chunk_text(text, budget)
        total = len(chunks)
        if total > _MAX_CHUNKS:
            return self._resolved("llm_query_chunked", [
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
        return self._task("llm_query_chunked", tuple(rids), _reduce_chunked(sizes), f"{total} chunks")
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
            return self._resolved("spawn", _surfaced_error(
                "spawn() takes llm_query, llm_batch, llm_query_chunked, map_files, "
                "rlm_query or rlm_batch — not llm_map_reduce, whose reduce step depends "
                "on its own map results and so cannot be a single Task"))
        # Sub-LLM kinds already post detached via _post; keep the flag for clarity / future kinds.
        self._detached = True
        try:
            return builder(*args, **kwargs)
        except TypeError as e:
            return self._resolved("spawn", _surfaced_error(f"bad spawn arguments — {e}"))
        finally:
            self._detached = False

    def _task(self, kind: str, rids, reduce, label: str = "") -> Task:
        t = Task(self, kind, rids, reduce, label)
        self._handles.append(t)
        return t

    def _resolved(self, kind: str, value: Any, label: str = "") -> Task:
        t = Task.resolved(self, kind, value, label)
        self._handles.append(t)
        return t

    def _live_handles(self) -> list[Task]:
        return [t for t in self._handles if not t._settled]

    def _task_name_map(self) -> dict[int, str]:
        return {id(v): k for k, v in self.ns.items() if isinstance(v, Task)}

    def _list_tasks(self) -> list[dict[str, Any]]:
        """[{kind, label, done, var}] for every Task this worker created."""
        names = self._task_name_map()
        return [
            {"kind": t.kind, "label": t.label, "done": t.done, "var": names.get(id(t))}
            for t in self._handles
        ]

    def _pending_task_infos(self) -> list[dict[str, Any]]:
        names = self._task_name_map()
        return [
            {"var": names.get(id(t)), "kind": t.kind, "label": t.label}
            for t in self._live_handles()
        ]

    def _await_one(self, task: Task, *, block: bool = True) -> Any:
        """Collect one Task. Idempotent — the value is memoized.

        A stall does not settle the Task; the same handle can be awaited again.
        `block=False` settles only if the reply is already parked (batch union drain).
        """
        if task._settled:
            return task._value
        ready = all(r in self.inbox for r in task._rids)
        if not ready:
            if not block or not self._drain_until(task._rids):
                return _surfaced_error(_stall_message(self.await_timeout_s))
        task._value = task._reduce(self._take(task._rids))
        task._settled = True
        return task._value

    def _await_task(self, task_or_tasks=None) -> Any:
        """Collect result(s). Accepts a Task, a list/tuple of Tasks, or nothing.

        No argument: collect every still-running Task this worker created (the recovery
        path when the model lost the handle). One live Task unwraps to its result;
        several return a list.
        Canonical name for the model: await_task(...). (bare `await` is a Python keyword.)
        """
        if task_or_tasks is None:
            live = self._live_handles()
            if not live:
                return _surfaced_error(
                    "await_task() found no running Tasks — bind rlm_batch/llm_query to a name "
                    "and pass it, or call list_tasks()"
                )
            # One live Task (the usual lost-handle case) unwraps so
            # `reports = await_task()` matches `reports = await_task(t)`.
            if len(live) == 1:
                return self._await_one(live[0])
            return self._await_task(live)
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
            out: list[Any] = [None] * len(tasks)
            for i, t in enumerate(tasks):
                if isinstance(t, Task):
                    # Union already waited once — do not stall again per item.
                    out[i] = self._await_one(t, block=False)
                else:
                    out[i] = _surfaced_error(
                        f"await_task expects Task items, got {type(t).__name__}"
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
            return self._resolved("map_files", {})

        # Per-file prompt budget; anything larger is chunked and its answers concatenated.
        budget = self.max_prompt_chars - len(prompt) - _CHUNK_HEADER_OVERHEAD - 256
        if budget < 1_000:
            return self._resolved("map_files", {
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
        return self._task("map_files", tuple(rids),
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

    def _list_claims(self) -> str:
        """v5 blackboard: the host TaskLedger's claims table (inflight + done work)."""
        r = self._rpc("ledger_claims", {})
        if r.get("error"):
            return f"Error: {r['error']}"
        return str(r.get("response") or "ledger: no claims")

    def _memory_rpc(self, op: str, payload: dict[str, Any]) -> str:
        r = self._rpc("memory", {"op": op, **payload})
        if r.get("error"):
            return f"Error: {r['error']}"
        return str(r.get("response") or "")

    def _memory_api(self) -> "_MemoryApi":
        return _MemoryApi(self)

    # ---- context + execution --------------------------------------------------------------
