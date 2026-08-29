from .retry import with_retry


def get_json(url: str):
    def call(timeout):
        return {"url": url, "timeout": timeout, "ok": True}

    return with_retry(call)
