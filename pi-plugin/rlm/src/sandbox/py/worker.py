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
    RESERVED,
    REAL_STDERR as _REAL_STDERR,
    REAL_STDIN as _REAL_STDIN,
)
from hostio import read_host_payload
from retrieval import _Bm25Index, _NUDGE_CHARS
from tasks import Task

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



from scaffold import WorkerScaffold


class Worker(WorkerScaffold):
    def __init__(
        self,
        depth: int,
        exec_timeout_s: float,
        max_prompt_chars: int,
        await_timeout_s: float = 600.0,
        surface: str = "root",
    ):
        self.depth = depth
        self.exec_timeout_s = exec_timeout_s
        self.max_prompt_chars = max_prompt_chars
        self.await_timeout_s = await_timeout_s
        # v5 role separation: "child" installs the delegation-only scaffold (no retrieval —
        # a child's world arrives as text via getChildContext; retrieval belongs to the root).
        self.surface = surface
        self._rid = 0
        self._final_answer: str | None = None
        # Replies parked by rid until something awaits them. Unbounded by design: a task
        # the model spawns and never awaits keeps its entry for the life of the process.
        # Bounded in practice by session length; evicting would silently hang a later
        # await_task, which is strictly worse than the memory.
        self.inbox: dict[str, dict[str, Any]] = {}
        self._inflight: set[str] = set()
        # Every Task this worker created. Survives the model deleting the bound name, so
        # await_task() / list_tasks() can still collect a spawn the model forgot to store.
        self._handles: list[Task] = []
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
        ns["list_tasks"] = self._list_tasks
        ns["map_files"] = self._map_files
        ns["llm_map_reduce"] = self._llm_map_reduce
        if self.surface != "child":
            ns["search"] = self._search
            ns["grep_context"] = self._grep_context
            ns["outline"] = self._outline
        # env_tips memo: collected *results* live in `answers`; Task handles live in REPL vars.
        # Re-created only when deleted — contents must survive every turn.
        if not isinstance(ns.get("answers"), dict):
            ns["answers"] = {}
        if not isinstance(ns.get("plan"), dict):
            ns["plan"] = {}
        if self.surface != "child":
            ns["add_context"] = self._add_context
        ns["list_claims"] = self._list_claims
        ns["memory"] = self._memory_api()
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
        avail: dict[str, str] = {}
        for k in self._user_var_names():
            v = self.ns[k]
            avail[k] = repr(v) if isinstance(v, Task) else type(v).__name__
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
            "pending_tasks": self._pending_task_infos(),
        }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=int(os.environ.get("RLM_DEPTH", "1")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("RLM_EXEC_TIMEOUT_S", "600")))
    ap.add_argument("--await-timeout", type=float,
                    default=float(os.environ.get("RLM_AWAIT_TIMEOUT_S", "600")))
    ap.add_argument("--max-prompt-chars", type=int,
                    default=int(os.environ.get("RLM_MAX_PROMPT_CHARS", "400000")))
    ap.add_argument("--surface", default=os.environ.get("RLM_SURFACE", "root"),
                    choices=["root", "child"])
    args = ap.parse_args()

    worker = Worker(depth=args.depth, exec_timeout_s=args.timeout,
                    max_prompt_chars=args.max_prompt_chars,
                    await_timeout_s=args.await_timeout,
                    surface=args.surface)
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
