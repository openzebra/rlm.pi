"""RLM sandbox worker: a persistent Python REPL driven over a JSONL stdio protocol.

Executes model-authored Python with secrets stripped from the environment.
This is NOT a security sandbox: __import__ and open are available, so code can import networking modules
(socket, urllib, subprocess) and read/write local files. Trust the root model's code.

Protocol (parent -> worker):  {"id","type":"exec"|"load_context"|"shutdown", ...}
Protocol (worker -> parent):  {"id","ok",...result}            # response to a request
                              {"type":"llm_query"|"llm_query_batched"|"rlm_query"|...
                               "read_file"|"grep"|"find","rid",...}
                                                                # mid-exec helper request
When sandbox code calls llm_query/rlm_query/read_file/grep/find, the worker writes a request line
and BLOCKS reading stdin until the matching {"type":"llm_reply","rid",...} arrives. The parent
services the request in-process (it holds API keys and implements ergonomic file helpers).
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
    {
        "llm_query", "llm_query_batched", "rlm_query", "rlm_query_batched",
        "read_file", "grep", "find", "propose_edit", "SHOW_EDITS", "SHOW_VARS", "answer", "context", "context_0",
    }
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
        self._edits: list[dict[str, str]] = []
        self._context_count = 0
        self.ns: dict[str, Any] = {}
        self._setup()

    def _setup(self) -> None:
        self.ns = {"__builtins__": _SAFE_BUILTINS.copy(), "__name__": "__main__"}
        self._restore_scaffold()

    def _capture_answer(self, content: Any) -> None:
        self._final_answer = str(content)

    def _restore_scaffold(self) -> None:
        # Re-inject any scaffolding the user code clobbered.
        ns = self.ns
        ns["llm_query"] = self._llm_query
        ns["llm_query_batched"] = self._llm_query_batched
        ns["rlm_query"] = self._rlm_query
        ns["rlm_query_batched"] = self._rlm_query_batched
        ns["read_file"] = self._read_file
        ns["grep"] = self._grep
        ns["find"] = self._find
        ns["propose_edit"] = self._propose_edit
        ns["SHOW_EDITS"] = self._show_edits
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
        # Restore the context alias (reference: context = context_0 every cell).
        if "context_0" in ns:
            ns["context"] = ns["context_0"]

    def _show_vars(self) -> str:
        avail = {
            k: type(v).__name__
            for k, v in self.ns.items()
            if not k.startswith("_") and not k.startswith("context_") and k not in RESERVED and k != "__builtins__"
        }
        return f"Available variables: {avail}" if avail else "No variables created yet."

    def _show_edits(self) -> str:
        if not self._edits:
            return "No proposed edits."
        lines = [f"Proposed edits: {len(self._edits)}"]
        for i, e in enumerate(self._edits, 1):
            old_lines = str(e.get("oldText", "")).count("\n") + 1
            new_lines = str(e.get("newText", "")).count("\n") + 1
            lines.append(
                f"{i}. {e.get('path', '')}: old {len(e.get('oldText', ''))} chars/{old_lines} lines -> "
                f"new {len(e.get('newText', ''))} chars/{new_lines} lines"
            )
        return "\n".join(lines)

    # ---- sub-LLM bridge over stdio --------------------------------------------------------

    def _rpc(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._rid += 1
        rid = f"q{self._rid}"
        _send({"type": kind, "rid": rid, "depth": self.depth, **payload})
        # The per-cell SIGALRM is wall-clock; it must not count time blocked here waiting for
        # a sub-LLM reply (network/LLM latency, not local CPU). Pause it across the readline.
        pause = self.exec_timeout_s > 0 and hasattr(signal, "SIGALRM")
        if pause:
            remaining = signal.getitimer(signal.ITIMER_REAL)[0]
            signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            while True:
                line = _REAL_STDIN.readline()
                if not line:
                    raise RuntimeError("parent closed the pipe during a sub-LLM request")
                msg = json.loads(line)
                if msg.get("type") == "llm_reply" and msg.get("rid") == rid:
                    return msg
                # The parent only ever sends our reply mid-exec; anything else is a protocol error.
                raise RuntimeError(f"unexpected parent message during sub-LLM request: {msg!r}")
        finally:
            if pause and remaining > 0:
                signal.setitimer(signal.ITIMER_REAL, remaining)

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

    def _read_file(self, path: str, start: int | None = None, end: int | None = None) -> str:
        r = self._rpc("read_file", {"path": str(path), "start": start, "end": end})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

    def _grep(self, pattern: str, glob: str | None = None, max_matches: int | None = None) -> str:
        r = self._rpc("grep", {"pattern": str(pattern), "glob": glob, "maxMatches": max_matches})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

    def _find(self, glob: str | None = None) -> str:
        r = self._rpc("find", {"glob": glob})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

    def _propose_edit(self, path: str, old: str, new: str) -> str:
        """Validate an anchor edit with the parent; record it on success.

        Does NOT write to disk — the parent applies edits after the run, with approval.
        Returns a short preview, or an `Error: …` string the model can act on.
        """
        path_s = str(path)
        old_s = str(old)
        new_s = str(new)
        proposed = {"path": path_s, "oldText": old_s, "newText": new_s}
        if proposed in self._edits:
            return "ok — duplicate edit already proposed"
        existing = [e for e in self._edits if e.get("path") == path_s]
        r = self._rpc("propose_edit", {"path": path_s, "old": old_s, "new": new_s, "existingEdits": existing})
        if r.get("error"):
            return f"Error: {r['error']}"
        response = r.get("response", "ok")
        if isinstance(response, str) and response.startswith("Error:"):
            return response
        self._edits.append(proposed)
        return response if isinstance(response, str) else "ok"

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

    def load_context(self, path: str, index: int | None = None, is_json: bool = False) -> int:
        if index is None:
            index = self._context_count
        with open(path, "r") as f:
            payload = json.load(f) if is_json else f.read()
        self.ns[f"context_{index}"] = payload
        if index == 0:
            self.ns["context"] = payload
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
        return {
            "stdout": stdout,
            "stderr": stderr,
            "final_answer": final,
            "answer_content": str(answer_content),
            "edits": list(self._edits),
            "raised": raised,
            "execution_time": time.perf_counter() - start,
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
