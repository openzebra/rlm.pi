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
- Hard sub-problems **recurse** into child RLMs via `rlm_query` (depth-capped).
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
| `/rlm-resume` | | Resume an interrupted run (default `@latest`) |
| `/rlm-runs` | | List recent runs |
| `/rlm-help` | | Show the startup guide & cheatsheet |

While a run is active, a **live tree** shows the root orchestrator and every sub-LLM /
recursive child with status, model, cost, tokens, and duration. The final answer is posted
to the chat as markdown; any code edits are collected as diffs and reviewed via a popup
(unless `yolo` is on).

## Sandbox API

These functions are injected into the model's Python namespace inside the REPL:

| Function | Signature | Description |
|---|---|---|
| `context` | `list[dict]` | Repository packed as `[{"path","content","tokens"}, ...]` — the full codebase |
| `llm_query` | `(prompt, model=None) -> str` | One-shot sub-LLM call (worker model) |
| `llm_query_batched` | `(prompts, model=None) -> list[str]` | Concurrent sub-LLM calls (pool-bounded) |
| `llm_query_chunked` | `(text, prompt, model=None) -> list[str]` | Split large text into cap-sized chunks and fan out via sub-LLMs |
| `rlm_query` | `(prompt, model=None) -> str` | Recursive child RLM with its own sandbox (depth-capped) |
| `rlm_query_batched` | `(prompts, model=None) -> list[str]` | Concurrent recursive child RLMs |
| `todo` | `(action, **kwargs) -> str` | Task list: `create`/`update`/`list`/`get`/`delete`/`clear` |
| `ask_user_question` | `(questions) -> list[dict]` | Ask the user structured questions (depth 0 only) |
| `load_library` | `(source) -> dict \| str` | Load an external dir, file, or git URL into a new `context_N` slot |
| `stage_edit` | `(path, old_text, new_text) -> str` | Stage a file edit; relayed to the host's native edit flow |
| `save_artifact` | `(kind, content) -> str` | Persist a stage artifact (`clarification` / `research` / `plan` / `validation`) under `.rlm/artifacts/` (root depth only) |
| `advance_phase` | `(phase, summary=None) -> str` | Advance one step in order `clarify → research → blueprint → implement → validate` (clarify skipped when `askUserQuestion` is off). **Engine-gated** on the latest artifact + interview rounds. Rejected transitions return the gate error. |
| `SHOW_VARS` | `() -> str` | List currently defined variables & their types |
| `answer` | `dict` | Set `answer["content"]=...; answer["ready"]=True` to finalize |

### Loading external libraries

When the task needs an **external library, another source tree, or standalone docs** that are
not in the packed repo `context`, the model calls `load_library(source)` mid-run:

```python
info = load_library("../some-lib")           # local directory → repomix-packed list[dict]
info = load_library("docs/api.md")           # single file → plain str
info = load_library("https://github.com/x/y.git")  # shallow clone, then pack
# info == {"index": 1, "var": "context_1", "files": …, "chars": …}
# then chunk context_1 exactly like context
```

Slots start at `context_1` (`context` / `context_0` remains the repo). Toggle via
`/rlm-config` → **Library loader** (`libraryLoader`, default on). On headless runs with
persistence, each loaded slot is written as a resume sidecar (`context.<N>.json`).

### Artifact-gated pipeline (opt-in via `pipeline: true`)

When enabled at root depth:

1. **Goal capture** — the brief is written verbatim to `.rlm/artifacts/goal/goal-<ts>.md` with a pre-run dirty-tree baseline.
2. **Stages** — `clarify → research → blueprint → implement → validate`. Each produces a durable markdown artifact with frontmatter contracts; chat history is **reset** at every phase boundary (artifacts are the only channel; REPL vars persist).
3. **Clarify (intake)** — interviews the user via `ask_user_question` (intent first, then evidence-confirmed decisions). Writes `.rlm/artifacts/clarifications/*` with `decisions_count` / `open_questions_count`. Engine gate: **≥1 serviced ask round** + artifact contract. When **`askUserQuestion` is off**, clarify is skipped and the run starts at research.
4. **Gates (TypeScript, never LLM judgment)** — `status: ready`; clarify structure; plan `phases:` ≡ fence-aware `## Phase N:` headings; every `file:line` citation resolves; validate carries `blockers_count` + `verdict`.
5. **Implement fanout** — on `advance_phase("implement")` the engine runs one **serial** child RLM per plan phase and applies that child's edits before the next phase starts.
6. **Corrective loop** — `blockers_count > 0` re-enters blueprint, bounded by `maxBackwardJumps` (default 2).

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---|---|---|
| Smart model | Pi's active model | the root orchestrator |
| Worker model | cheapest available | answers `llm_query` |
| Max recursion depth | `4` | `rlm_query` past this degrades to plain `llm_query` |
| Max iterations | `30` | root REPL turns before RLM asks for a final answer |
| REPL block timeout (s) | `120` | wall-clock limit for one Python REPL block (SIGALRM) |
| Max concurrent sub-calls | `4` | concurrency pool size for `*_batched` |
| Budget ceiling (USD) | none | total spend cap for the whole recursive tree |
| Wall-clock ceiling (min) | none | total runtime cap for the whole recursive tree |
| Token ceiling | none | total input+output token cap for the whole recursive tree |
| Max consecutive errors | `5` | stop after N consecutive failing turns (none = off) |
| Orchestrator addendum | on | divide-and-conquer guidance in the root system prompt |
| Phase pipeline | off | artifact-gated clarify→research→blueprint→implement fanout→validate |
| Max validate→blueprint loops | `2` | bounded corrective re-entries when validation reports blockers |
| Ask user question | on | when pipeline is on, enables clarify intake; when off, pipeline starts at research |
| Trajectory compaction | on (0.65) | summarize old turns when history nears the context window |
| Root model output cap (tok) | `16384` | max output tokens per root-model turn |
| Sandbox init timeout | `30000` ms | how long to wait for the Python worker to start |
| `askUserQuestion` | on | expose `ask_user_question()` to the model |
| `todo` | on | expose `todo()` to the model |
| Library loader | on | expose `load_library()` for external dirs/files/git repos |

> **Concurrency note:** each `rlm_query` child spawns its own `python3` worker (~50–150 ms
> cold start). Worst-case concurrent interpreters ≈ `maxConcurrentSubcalls`^(depth−1); at
> defaults (depth 4, conc 4) that's 4³ = 64 in the pathological case. Budget and error
> caps (above) bound total spend regardless of fan-out.

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
