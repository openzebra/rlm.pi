"""Execution guardrails for the RLM sandbox worker.

The restricted builtin table, the reserved-name set that keeps scaffold functions out of
SHOW_VARS, the protocol writer that must always reach the REAL stdout (user prints are
captured into a buffer), and the per-exec stall alarm.

This is steering, not a security boundary: `__import__` and `open` are deliberately available,
so model code can still reach the network and the filesystem. What it does buy is that the
scaffold cannot be clobbered silently and that a blocked builtin explains itself instead of
failing as "'NoneType' object is not callable".
"""

from __future__ import annotations

import json
import re
import signal
import sys
from contextlib import contextmanager
from typing import Any

# Capture the REAL stdio before exec() redirects sys.stdout/sys.stderr into buffers.
# All protocol writes must go to the real stdout even while user code's prints are captured.
REAL_STDOUT = sys.stdout
REAL_STDIN = sys.stdin
REAL_STDERR = sys.stderr


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
        "load_library",
        "SHOW_VARS", "answer", "context",
    }
)
# NOTE: `answers` and `plan` are deliberately NOT reserved. They are seeded by the scaffold but
# owned by the model, so they must appear in SHOW_VARS.
# Only the single name `context` is the packed world. Legacy context_N names are filtered out.
_CONTEXT_NAME = re.compile(r"context(_\d+)?\Z")

def _send(obj: dict[str, Any]) -> None:
    REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    REAL_STDOUT.flush()


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


def _surfaced_error(message: str) -> str:
    """The "Error: …" contract value, ALSO written to the cell's stderr.

    A spawn/await misuse whose only trace is the returned value reads to the model as a random
    string much later — which is exactly how `tasks.items()` blew up on a str.
    """
    print(f"[rlm] {message}", file=sys.stderr)
    return f"Error: {message}"
