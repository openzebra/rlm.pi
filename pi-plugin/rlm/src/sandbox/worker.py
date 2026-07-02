"""RLM sandbox worker: a persistent Python REPL driven over a JSONL stdio protocol.

Executes model-authored Python with secrets stripped from the environment.
This is NOT a security sandbox: __import__ and open are available, so code can import networking modules
(socket, urllib, subprocess) and read/write local files. Trust the root model's code.

Protocol (parent -> worker):  {"id","type":"exec"|"load_context"|"shutdown", ...}
Protocol (worker -> parent):  {"id","ok",...result}            # response to a request
                              {"type":"llm_query"|"llm_query_batched"|"rlm_query"|...
                               "advance_phase"|"ask_user_question"|"todo","rid",...}
                                                                # mid-exec helper request
When sandbox code calls llm_query/rlm_query/advance_phase/ask_user_question/todo, the worker writes a request line
and BLOCKS reading stdin until the matching {"type":"llm_reply","rid",...} arrives. The parent
services the request in-process (it holds API keys).
"""

from __future__ import annotations

import argparse
import io
import json
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
# `open` is allowed (data work needs files); eval/exec/compile/input/globals/locals are not.
_SAFE_BUILTINS["open"] = open
for _blocked in ("eval", "exec", "compile", "input", "globals", "locals"):
    _SAFE_BUILTINS[_blocked] = None

RESERVED = frozenset(
    {
        "llm_query", "llm_query_batched", "llm_query_chunked",
        "rlm_query", "rlm_query_batched",
        "advance_phase",
        "ask_user_question", "todo",
        "stage_edit",
        "SHOW_VARS", "answer", "context",
    }
)
_CONTEXT_SLOT = re.compile(r"context(_\d+)?\Z")

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
    def __init__(self, depth: int, exec_timeout_s: float, max_prompt_chars: int):
        self.depth = depth
        self.exec_timeout_s = exec_timeout_s
        self.max_prompt_chars = max_prompt_chars
        self._rid = 0
        self._final_answer: str | None = None
        self._context_count = 0
        self.ns: dict[str, Any] = {}
        self._setup()

    def _setup(self) -> None:
        self.ns = {"__builtins__": _SAFE_BUILTINS.copy(), "__name__": "__main__"}
        self._ctx_payloads: dict[int, Any] = {}
        self._staged_edits: list[dict[str, str]] = []
        self._nudged: set[str] = set()
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
        ns["advance_phase"] = self._advance_phase
        ns["ask_user_question"] = self._ask_user_question
        ns["todo"] = self._todo
        ns["stage_edit"] = self._stage_edit
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
        # Context slots are ordinary variables (RLM paper: the context lives in the
        # environment and the model may transform it in place). Re-inject only if the
        # model deleted the name entirely; mutations and re-binds persist within the run.
        # Resume reloads pristine context; keep derived resume-critical values in user vars.
        for idx, payload in self._ctx_payloads.items():
            ns.setdefault(f"context_{idx}", payload)
        if 0 in self._ctx_payloads:
            ns.setdefault("context", self._ctx_payloads[0])

    def _user_var_names(self) -> list[str]:
        """User-created variable names — filters builtins, scaffold, and context slots.

        Shared by SHOW_VARS() and the exec result so both expose the same namespace view.
        This is the cheap orientation hint that goes into history instead of full stdout.
        """
        return [
            k for k in self.ns
            if not k.startswith("_")
            and not _CONTEXT_SLOT.match(k)
            and k not in RESERVED
        ]

    def _show_vars(self) -> str:
        avail = {k: type(self.ns[k]).__name__ for k in self._user_var_names()}
        return f"Available variables: {avail}" if avail else "No variables created yet."

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
                # Stray/late message (e.g. a reply to an earlier timed-out request): skip it.
                print(
                    f"[rlm-sandbox] ignoring unexpected message during sub-LLM request: {str(msg)[:200]}",
                    file=_REAL_STDERR,
                )
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

    def _llm_query_chunked(self, text, prompt: str, model: str | None = None) -> list[str]:
        """Split oversized text into cap-sized chunks and fan out via llm_query_batched.

        Returns one answer per chunk, order preserved. No exceptions escape: errors come
        back as "Error: ..." strings per chunk (same contract as llm_query_batched).

        NOTE: budget uses Python code-point length (len) while the parent-side cap check counts
        UTF-16 units (JS string.length); astral/emoji-heavy text may be marginally larger on the
        parent and get per-chunk rejected. Acceptable trade-off for typical code/log/profile text.
        """
        text, prompt = str(text), str(prompt)
        if not text:
            return []
        budget = self.max_prompt_chars - len(prompt) - _CHUNK_HEADER_OVERHEAD
        if budget < 1_000:
            return [f"Error: prompt leaves under 1,000 chars per chunk (cap {self.max_prompt_chars:,}) — shorten the instruction"]
        chunks = _chunk_text(text, budget)
        total = len(chunks)
        if total > _MAX_CHUNKS:
            return [f"Error: {total} chunks would be needed — filter/slice the text in Python first"]
        results: list[str] = []
        for i in range(0, total, _MAX_CHUNK_BATCH):
            batch = [
                f"{prompt}\n\n[chunk {i + j + 1}/{total} of the input]\n{c}"
                for j, c in enumerate(chunks[i:i + _MAX_CHUNK_BATCH])
            ]
            results.extend(self._llm_query_batched(batch, model))
        return results

    def _rlm_query(self, prompt: str, model: str | None = None) -> str:
        r = self._rpc("rlm_query", {"prompt": str(prompt), "model": model})
        return f"Error: {r['error']}" if r.get("error") else r.get("response", "")

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

    def _stage_edit(self, path: str, old_text: str, new_text: str) -> str:
        if not isinstance(path, str) or not isinstance(old_text, str) or not isinstance(new_text, str):
            return "Error: path, old_text, new_text must be strings"
        self._staged_edits.append({"path": path, "oldText": old_text, "newText": new_text})
        return f"Staged edit for {path} ({len(old_text)} → {len(new_text)} chars)"

    def _advance_phase(self, phase: str, summary: str | None = None) -> str:
        """Transition the root RLM pipeline to a new phase.

        Only callable at depth 0. The parent handler validates the transition
        against the phase state machine (research → blueprint → implement → validate).
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
        self._ctx_payloads[index] = payload
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
        edits, self._staged_edits = self._staged_edits, []
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
            "edits": edits,
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
            if k.startswith("_") or _CONTEXT_SLOT.match(k) or k in RESERVED or k == "__builtins__":
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
        with open(tmp, "wb") as f:
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
        with open(path, "rb") as f:
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
    ap.add_argument("--max-prompt-chars", type=int,
                    default=int(os.environ.get("RLM_MAX_PROMPT_CHARS", "400000")))
    args = ap.parse_args()

    worker = Worker(depth=args.depth, exec_timeout_s=args.timeout,
                    max_prompt_chars=args.max_prompt_chars)
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
