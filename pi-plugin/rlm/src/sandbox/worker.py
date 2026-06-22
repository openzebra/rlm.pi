"""RLM sandbox worker: a persistent Python REPL driven over a JSONL stdio protocol.

The parent (TypeScript) and this worker speak newline-delimited JSON over stdin/stdout.
No sockets, no HTTP, no network — the only channel is this pipe.

Protocol (parent -> worker):  {"id","type":"exec"|"load_context"|"bootstrap"|"shutdown", ...}
Protocol (worker -> parent):  {"id","ok",...result}            # response to a request
                              {"type":"llm_query"|"llm_query_batched"|"rlm_query","rid",...}
                                                                # mid-exec sub-LLM request
When sandbox code calls llm_query/rlm_query, the worker writes a request line and BLOCKS
reading stdin until the matching {"type":"llm_reply","rid",...} arrives. The parent services
the request in-process (it holds the API keys; this worker never sees them).
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

# Capture the REAL stdout/stdin before exec() redirects sys.stdout into a buffer.
# All protocol writes must go to the real stdout even while user code's prints are captured.
_REAL_STDOUT = sys.stdout
_REAL_STDIN = sys.stdin


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
# `open` is allowed (data work needs files); eval/exec/compile/input/globals/locals are not.
_SAFE_BUILTINS["open"] = open
for _blocked in ("eval", "exec", "compile", "input", "globals", "locals"):
    _SAFE_BUILTINS[_blocked] = None

RESERVED = frozenset(
    {"llm_query", "llm_query_batched", "rlm_query", "rlm_query_batched", "SHOW_VARS", "answer", "context"}
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


def _send(obj: dict[str, Any]) -> None:
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


class Worker:
    def __init__(self, depth: int, exec_timeout_s: float):
        self.depth = depth
        self.exec_timeout_s = exec_timeout_s
        self._rid = 0
        self._final_answer: str | None = None
        self._context_count = 0
        self.globals: dict[str, Any] = {}
        self.locals: dict[str, Any] = {}
        self._setup()

    def _setup(self) -> None:
        self.globals = {"__builtins__": _SAFE_BUILTINS.copy(), "__name__": "__main__"}
        self.locals = {}
        self.globals["llm_query"] = self._llm_query
        self.globals["llm_query_batched"] = self._llm_query_batched
        self.globals["rlm_query"] = self._rlm_query
        self.globals["rlm_query_batched"] = self._rlm_query_batched
        self.globals["SHOW_VARS"] = self._show_vars
        self.locals["answer"] = _AnswerDict(self._capture_answer)

    def _capture_answer(self, content: Any) -> None:
        self._final_answer = str(content)

    def _restore_scaffold(self) -> None:
        # Re-inject any scaffolding the user code clobbered.
        g = self.globals
        g.setdefault("llm_query", self._llm_query)
        g.setdefault("llm_query_batched", self._llm_query_batched)
        g.setdefault("rlm_query", self._rlm_query)
        g.setdefault("rlm_query_batched", self._rlm_query_batched)
        g.setdefault("SHOW_VARS", self._show_vars)
        if not isinstance(self.locals.get("answer"), _AnswerDict):
            cur = self.locals.get("answer")
            ans = _AnswerDict(self._capture_answer)
            if isinstance(cur, dict):
                for k, v in cur.items():
                    dict.__setitem__(ans, k, v)
                if cur.get("ready") and self._final_answer is None:
                    self._final_answer = str(cur.get("content", ""))
            self.locals["answer"] = ans

    def _show_vars(self) -> str:
        avail = {
            k: type(v).__name__
            for k, v in self.locals.items()
            if not k.startswith("_") and k != "answer"
        }
        return f"Available variables: {avail}" if avail else "No variables created yet."

    # ---- sub-LLM bridge over stdio --------------------------------------------------------

    def _rpc(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._rid += 1
        rid = f"q{self._rid}"
        _send({"type": kind, "rid": rid, "depth": self.depth, **payload})
        while True:
            line = _REAL_STDIN.readline()
            if not line:
                raise RuntimeError("parent closed the pipe during a sub-LLM request")
            msg = json.loads(line)
            if msg.get("type") == "llm_reply" and msg.get("rid") == rid:
                return msg
            # The parent only ever sends our reply mid-exec; anything else is a protocol error.
            raise RuntimeError(f"unexpected parent message during sub-LLM request: {msg!r}")

    def _llm_query(self, prompt: str, model: str | None = None) -> str:
        r = self._rpc("llm_query", {"prompt": str(prompt), "model": model})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

    def _llm_query_batched(self, prompts, model: str | None = None) -> list[str]:
        prompts = [str(p) for p in prompts]
        if not prompts:
            return []
        r = self._rpc("llm_query_batched", {"prompts": prompts, "model": model})
        if r.get("error"):
            return [f"Error: {r['error']}"] * len(prompts)
        out = r.get("responses")
        if not isinstance(out, list) or len(out) != len(prompts):
            return ["Error: malformed batched response"] * len(prompts)
        return [s if isinstance(s, str) else f"Error: {s}" for s in out]

    def _rlm_query(self, prompt: str, model: str | None = None) -> str:
        r = self._rpc("rlm_query", {"prompt": str(prompt), "model": model})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

    def _rlm_query_batched(self, prompts, model: str | None = None) -> list[str]:
        prompts = [str(p) for p in prompts]
        if not prompts:
            return []
        r = self._rpc("rlm_query_batched", {"prompts": prompts, "model": model})
        if r.get("error"):
            return [f"Error: {r['error']}"] * len(prompts)
        out = r.get("responses")
        if not isinstance(out, list) or len(out) != len(prompts):
            return ["Error: malformed batched response"] * len(prompts)
        return [s if isinstance(s, str) else f"Error: {s}" for s in out]

    # ---- context + execution --------------------------------------------------------------

    def load_context(self, payload: Any, index: int | None = None) -> int:
        if index is None:
            index = self._context_count
        self.locals[f"context_{index}"] = payload
        if index == 0:
            self.locals["context"] = payload
        self._context_count = max(self._context_count, index + 1)
        return index

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

    def execute(self, code: str) -> dict[str, Any]:
        start = time.perf_counter()
        with self._capture() as (out, err):
            try:
                ns = {**self.globals, **self.locals}
                self._exec(code, ns)
                for k, v in ns.items():
                    if k not in self.globals and not k.startswith("__"):
                        self.locals[k] = v
                self._restore_scaffold()
                stdout, stderr = out.getvalue(), err.getvalue()
            except BaseException as e:  # noqa: BLE001
                stdout = out.getvalue()
                stderr = err.getvalue() + f"\n{type(e).__name__}: {e}\n" + traceback.format_exc()
        final, self._final_answer = self._final_answer, None
        keys = [
            k for k, v in self.locals.items()
            if not k.startswith("_") and isinstance(v, (str, int, float, bool, list, dict, tuple))
        ]
        return {
            "stdout": stdout,
            "stderr": stderr,
            "final_answer": final,
            "execution_time": time.perf_counter() - start,
            "locals_keys": keys,
        }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=int(os.environ.get("RLM_DEPTH", "1")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("RLM_EXEC_TIMEOUT_S", "600")))
    args = ap.parse_args()

    worker = Worker(depth=args.depth, exec_timeout_s=args.timeout)
    _send({"id": "_init", "ok": True})

    for raw in _REAL_STDIN:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            _send({"id": "?", "ok": False, "error": f"bad json: {e}"})
            continue
        rid, kind = req.get("id", "?"), req.get("type")
        try:
            if kind == "exec":
                _send({"id": rid, "ok": True, **worker.execute(req.get("code", ""))})
            elif kind == "load_context":
                idx = worker.load_context(req.get("payload"), req.get("index"))
                _send({"id": rid, "ok": True, "index": idx})
            elif kind == "bootstrap":
                code = req.get("code") or ""
                if code:
                    exec(compile(code, "<bootstrap>", "exec"), worker.globals)  # noqa: S102
                _send({"id": rid, "ok": True})
            elif kind == "shutdown":
                _send({"id": rid, "ok": True})
                return
            else:
                _send({"id": rid, "ok": False, "error": f"unknown type: {kind!r}"})
        except BaseException as e:  # noqa: BLE001
            _send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"})


if __name__ == "__main__":
    main()
