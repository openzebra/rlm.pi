# pi-rlm — Save 99% tokens, Recursive Language Model (RLM) for the Pi

<div align="center">

**Recursive Language Models (RLMs)**, implemented natively as a Pi extension —
FULLY LOCAL.

</div>

## Install

```bash
pi install npm:@hicaru/pi-rlm
```

To remove it later:

```bash
pi uninstall npm:@hicaru/pi-rlm
```

Then run `/reload` or restart Pi. Verify with `pi list` that the package appears in
`settings.packages`, and check that `/rlm`, `/rlm-config`, and `/rlm-stop` appear under **[Extensions]**.

<div align="center">

<a href="https://arxiv.org/abs/2512.24601"><img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" alt="pi-rlm"></a>

<sub>Modeled on the method in the RLM paper, reimplemented natively for Pi.</sub>

</div>

<div align="center">

<sub>
**English** &nbsp;·&nbsp; <a href="README.zh-CN.md">中文</a> &nbsp;·&nbsp; <a href="README.ru.md">Русский</a>
</sub>

</div>

---

A **Recursive Language Model (RLM)** is a task-agnostic inference paradigm where a
root language model orchestrates over near-infinite context by *programmatically*
examining, decomposing, and **recursively calling itself** over its input. RLMs
replace the canonical `llm.completion(prompt, model)` call with an
`rlm.completion(prompt, model)` call: the prompt/context is offloaded as a variable
in a REPL environment that the model interacts with, and the model can launch
sub-LLM and sub-RLM calls as ordinary functions in code.

This is a bet on a [CodeAct](https://arxiv.org/abs/2402.01030)-style harness — every
language model gets access to a code environment, sub-(R)LM calls are functions, and
context/prompts are objects in code — moving away from the JSON tool-calling standard.
A system built this way is *itself* a language model that relies on recursive
sub-LLM calls, hence the name.

`pi-rlm` brings that paradigm **natively into Pi**:

- A **root orchestrator** model drives a **persistent Python REPL** turn-by-turn.
- Long-context work is **delegated** to cheap worker models via `llm_query` / `llm_query_batched`.
- Hard sub-problems **recurse** into child RLMs via `rlm_query` (depth-capped). A child inherits
  its parent's `context` — every file loaded so far, including sources added with `add_context()` —
  so it runs the same retrieval primitives over the same paths. Inheritance costs no extra tokens:
  the content lives in the sandbox, and only a size line reaches the model.
- Everything runs **in-process** — the only external process is one local `python3` worker.

> This is a Pi-plugin reimplementation of the RLM method (see the [RLM paper](https://arxiv.org/abs/2512.24601)).
> It is **not** the Python library.

## How it works

```
          ┌─────────────────────────┐
          │     Pi coding agent     │
          └────────────┬────────────┘
                       │  /rlm
                       ▼
          ┌─────────────────────────┐  spawns   ┌────────────────────┐
          │  Smart model (root)     │ ────────►  │   Worker models    │
          │  drives a Python REPL   │ ◄────────  │   (cheap, fast)    │
          └────────────┬────────────┘  results  └────────────────────┘
                       │ recursion (depth-capped)
                       └────► child RLMs ────► (same loop)

   All local · one python3 process · no servers
```

- The **smart model** thinks and writes Python in a REPL.
- The **worker models** do the heavy lifting (read, summarize, classify).
- Hard sub-problems **recurse** into child RLMs.
- Everything runs **fully local** — your API keys never leave Pi.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `/rlm` | `Ctrl+Shift+R` | Toggle persistent RLM mode (route plain prompts through the RLM engine) |
| `/rlm-stop` | | Abort an in-progress run |
| `/rlm-config` | | Pick smart + worker models and tune run settings |

While a run is active, a **live tree** shows the root orchestrator and every sub-LLM /
recursive child with status, model, cost, tokens, and duration. The final answer is posted
to the chat as markdown. File changes use Pi's native `edit` / `write` tools (with their
built-in diff preview).

## Sandbox API

These functions are injected into the model's Python namespace inside the REPL:

| Function | Signature | Description |
|---|---|---|
| `context` | `list[dict]` | Loaded files as `[{"path","content","tokens"}, …]` — starts empty; cwd seeds on first `repl()` |
| `llm_query` | `(prompt, model=None) -> str` | One-shot sub-LLM call (worker model) |
| `llm_query_batched` | `(prompts, model=None) -> list[str]` | Concurrent sub-LLM calls (pool-bounded) |
| `llm_query_chunked` | `(text, prompt, model=None) -> list[str]` | Split large text into cap-sized chunks and fan out via sub-LLMs |
| `rlm_query` | `(prompt, model=None, paths=None) -> str` | Recursive child RLM with its own sandbox (depth-capped). Inherits your `context`; `paths` narrows it by prefix |
| `rlm_query_batched` | `(prompts, model=None, paths=None) -> list[str]` | Concurrent recursive child RLMs, sharing one `paths` slice |
| `add_context` | `(source) -> dict \| str` | Append a dir, file, document, or git URL into `context` under `ctx/<id>/` |
| `SHOW_VARS` | `() -> str` | List currently defined variables & their types |
| `answer` | `dict` | Set `answer["content"]=...; answer["ready"]=True` to finalize |

### Adding context

`context` starts empty. The working directory seeds automatically on the first `repl()` call
(un-prefixed paths so `search()` hits remain real paths for `edit`/`write`). For an **external
tree, document, or git URL**, call `add_context(source)`:

```python
info = add_context("../some-lib")                # local directory → packed + appended
info = add_context("docs/api.md")                # single file → one entry in context
info = add_context("report.pdf")                 # document → Markdown, then appended
info = add_context("https://github.com/x/y.git") # shallow clone, then pack + append
# Files land in the SAME `context` list under ctx/<source_id>/…
# info == {"source_id", "path_prefix", "files", "chars", "context_len", "already_loaded", "converted", "skipped", …}
lib = [f for f in context if f["path"].startswith(info["path_prefix"])]
```

There is no `context_1` / `context_2` — only `context`. Paths are namespaced so multiple
sources do not collide. Toggle via `/rlm-config` → **Context loader** (`contextLoader`,
default on) and **Auto-seed cwd** (`autoSeedCwd`, default on). A source loaded at any point is
inherited by every child spawned afterwards.

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---|---|---|
| Smart model | Pi's active model | the root orchestrator |
| Worker model | cheapest available | answers `llm_query` |
| Max recursion depth | `4` | `rlm_query` past this degrades to plain `llm_query` |
| Max iterations | `30` | root REPL turns before RLM asks for a final answer |
| REPL block timeout (s) | `120` | wall-clock limit for one Python REPL block (SIGALRM) |
| Max concurrent sub-calls | `16` | concurrency pool size for `*_batched` |
| Max concurrent children | `6` | concurrent `rlm_query` child engines per depth |
| Wall-clock ceiling (min) | none | total runtime cap for the whole recursive tree |
| Token ceiling | none | total input+output token cap for the whole recursive tree |
| Max consecutive errors | `5` | stop after N consecutive failing turns (none = off) |
| Orchestrator addendum | on | divide-and-conquer guidance in the root system prompt |
| Trajectory compaction | on (0.65) | summarize old turns when history nears the context window |
| Root model output cap (tok) | `16384` | max output tokens per root-model turn |
| Sandbox init timeout | `30000` ms | how long to wait for the Python worker to start |
| Context loader | on | expose `add_context()` for external dirs/files/documents/git repos |
| Auto-seed cwd | on | seed the working directory into `context` on the first `repl()` |

> **Concurrency note:** each `rlm_query` child spawns its own `python3` worker (~50–150 ms
> cold start). Children are bounded separately (`maxConcurrentChildren`, default 6) because
> each holds a full Python process and its own copy of the inherited context. Error and
> wall-clock caps (above) still bound a runaway tree.

## Subagents and environment

RLM never confiscates native file tools (`read` / `grep` / bash readers) unless `repl` is in
the **active** tool set — the paper's trade is all-or-nothing. Process-boundary subagents that
spawn pi with a `--tools` allowlist without `repl` therefore keep ordinary file access.

Optional env conventions (for packages that want an explicit full bypass):

| Env | Meaning |
|---|---|
| `PI_SUBAGENT_CHILD=1` | Full RLM bypass in this process (no tools / hooks / flags). |
| `PI_RLM_FORCE_IN_SUBAGENT=1` | Experimental: opt a child back into RLM. **Consumed on activate** (not inherited after). Refused when `PI_RLM_DEPTH >= maxDepth`. |
| `PI_RLM_DEPTH` | Cross-process depth counter (default `0`). Bumped when force-in activates. |

In-process recursion (`rlm_query`) still uses `maxDepth` from `/rlm-config` and is unrelated to
these env vars. Set `RLM_TRACE_FILE` to a path for JSONL traces of bypass / force / block-skip
decisions.

## Security

- **Key isolation**: provider keys live only in TypeScript (`AuthStorage`); the sandbox
  receives prompts and returns text — never keys.
- **Environment sanitization**: sensitive env vars (API keys, tokens) are stripped before the
  worker spawns. The worker cannot read provider credentials from `os.environ`.
- **NOT a security sandbox**: the Python worker exposes `__import__` and `open`. Model-authored
  code can import networking modules, read/write local files, and write protocol-shaped JSON to
  stdout. This tier trusts the root model's code; the stdio protocol isolates provider keys and
  process lifecycle, **not** adversarial code containment. A stronger sandbox (Docker, seccomp)
  can be added later behind a setting without protocol changes.
- **Restricted builtins**: no `eval`/`exec`/`compile`/`input`/`globals`/`locals`; per-block
  SIGALRM timeout + parent watchdog (SIGKILL on hang); budget / token / timeout /
  consecutive-error caps.
- **Trust**: project-local install requires Pi project trust.
