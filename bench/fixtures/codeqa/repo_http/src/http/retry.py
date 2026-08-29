"""HTTP retry helpers."""

DEFAULT_TIMEOUT_MS = 50
MAX_RETRIES = 3


def with_retry(fn, timeout_ms: int | None = None):
    """Call fn with retries. Uses DEFAULT_TIMEOUT_MS when timeout_ms is None."""
    timeout = DEFAULT_TIMEOUT_MS if timeout_ms is None else timeout_ms
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn(timeout)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    raise RuntimeError(f"failed after {MAX_RETRIES} retries: {last_err}")
