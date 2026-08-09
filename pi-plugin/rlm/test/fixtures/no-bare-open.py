"""Assert the sandbox scaffold never opens a file without stating its encoding.

Run by test/phase-encoding.ts check 6, under `-X warn_default_encoding`:

    python3 -X warn_default_encoding no-bare-open.py <path/to/src/sandbox/py>

Two nets, because neither alone is enough:

  * A static AST scan catches `open(...)` / `io.open(...)` with no `encoding=` anywhere in the
    scaffold, including branches this run never executes.
  * Turning EncodingWarning into an error catches the same mistake at runtime while hostio
    actually does its I/O — proof the helper itself is clean, not just lint-clean.

This is the ONLY automated guard that `hostio.read_host_payload` keeps its explicit
`encoding=`: a normal worker spawn passes `-X utf8=1`, which masks a missing one at runtime.
See the docstring in src/sandbox/py/hostio.py — do not drop either side of that net.

Exits 0 and prints "ok" when clean; prints "FAIL <details>" and exits 1 otherwise.
"""

from __future__ import annotations

import ast
import os
import pathlib
import sys
import tempfile
import warnings

# The scaffold files that must never leave encoding to the locale.
SCANNED = ("worker.py", "guards.py", "hostio.py")


def _is_open_call(func: ast.expr) -> bool:
    """True for `open(...)` and `io.open(...)`, the two spellings the scaffold uses."""
    if isinstance(func, ast.Name):
        return func.id == "open"
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "open"
        and isinstance(func.value, ast.Name)
        and func.value.id == "io"
    )


def scan(root: pathlib.Path) -> list[str]:
    """Report every open/io.open in SCANNED that does not pass encoding=."""
    bad: list[str] = []
    for name in SCANNED:
        path = root / name
        if not path.is_file():
            bad.append(f"{name}: missing")
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not _is_open_call(node.func):
                continue
            if not any(kw.arg == "encoding" for kw in node.keywords):
                bad.append(f"{name}:{node.lineno}: bare open/io.open")
    return bad


def exercise_hostio(root: pathlib.Path) -> None:
    """Round-trip a payload through the real helper with EncodingWarning promoted to an error."""
    # EncodingWarning is 3.10+; on older interpreters the AST scan carries the check alone.
    enc_warning = getattr(sys.modules["builtins"], "EncodingWarning", None)
    if enc_warning is not None:
        warnings.filterwarnings("error", category=enc_warning)

    sys.path.insert(0, str(root))
    from hostio import pin_stdio_utf8, read_host_payload

    pin_stdio_utf8()
    fd, tmp = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("ok")
        if read_host_payload(tmp, False) != "ok":
            raise AssertionError("read_host_payload did not round-trip its input")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        print("FAIL usage: no-bare-open.py <path/to/src/sandbox/py>")
        return 1
    root = pathlib.Path(sys.argv[1])
    # Static findings are reported BEFORE the runtime net runs: exercise_hostio raises on the
    # same class of defect, and an escaping traceback would otherwise swallow the file:line
    # list that actually tells you where to look.
    bad = scan(root)
    if bad:
        print("FAIL", "; ".join(bad))
        return 1
    exercise_hostio(root)
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
