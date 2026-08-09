"""Host↔worker transport, pinned to UTF-8.

Every byte the host hands this worker is UTF-8: the context temp files come from Node's
FileHandle.write(string) (default utf8, see sandbox/context-file.ts) and the JSONL frames come
off a pipe Node writes the same way. Python does NOT match that — text I/O defaults to the
locale encoding, which is cp1252 on a Western Windows install. That mismatch is issue #7: a
packed repo holding any non-ASCII byte raised UnicodeDecodeError before the REPL ever ran.

Encoding is therefore never left to the locale here. Interpreter-wide UTF-8 mode (-X utf8=1,
set by the host in sandbox.ts) covers model-written open(); these two functions cover the
scaffold's own I/O, and they win outright — PYTHONIOENCODING overrides -X utf8=1, and
reconfigure() overrides PYTHONIOENCODING.
"""

from __future__ import annotations

import io
import json
import sys
from typing import Any

ENCODING = "utf-8"


def read_host_payload(path: str, is_json: bool) -> Any:
    """Read a payload the host serialized to a temp file.

    Strict on decode errors by design. The host always writes UTF-8, so a failure here is a
    transport bug, not bad input — and errors="replace" would hand the model silently
    mojibake'd source code instead of surfacing the problem.

    The explicit encoding= is intentionally redundant with -X utf8=1 under a normal spawn:
    UTF-8 mode already makes the default encoding UTF-8. It still matters so a standalone
    import of this module (or a worker started without -X utf8=1) cannot silently reintroduce
    issue #7. phase-encoding.ts check 6 (AST / EncodingWarning) is the only automated guard
    that encoding= is present — do not drop either side of that net.
    """
    with io.open(path, "r", encoding=ENCODING) as f:
        return json.load(f) if is_json else f.read()


def pin_stdio_utf8() -> None:
    """Force the three real streams to UTF-8, whatever the locale or PYTHONIOENCODING says.

    The write side uses surrogatepass, not strict: model code can synthesize a lone surrogate
    (a bad decode, a truncated pair), and json.dumps(ensure_ascii=False) would then raise
    inside _send — killing the worker on a request it had already completed. The read side
    uses replace so a corrupt frame comes back as a "bad json" error response instead of an
    exception that escapes main()'s loop and takes the worker down (fail-soft I/O, AGENTS.md).
    """
    for stream, errors in (
        (sys.stdin, "replace"),
        (sys.stdout, "surrogatepass"),
        (sys.stderr, "surrogatepass"),
    ):
        if isinstance(stream, io.TextIOWrapper):  # not a TextIOWrapper under some test harnesses
            stream.reconfigure(encoding=ENCODING, errors=errors)
