# pi-rlm — Save 99% tokens, Recursive Language Model (RLM) for the Pi

<div align="center">

<video src="https://github.com/openzebra/rlm.pi/raw/refs/heads/master/animation/rlm_pi_explainer.mp4" controls width="854" poster="https://raw.githubusercontent.com/openzebra/rlm.pi/main/assets/hero.png"></video>

</div>

<div align="center">

**Recursive Language Models (RLMs)**, implemented natively as a Pi extension —
FULLY LOCAL.

</div>

<div align="center">

<a href="https://arxiv.org/abs/2512.24601"><img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" alt="pi-rlm"></a>

<sub>Modeled on the method in the RLM paper, reimplemented natively for Pi.</sub>

</div>

<div align="center">

<sub>
<b>English</b> &nbsp;·&nbsp; <a href="README.zh-CN.md">中文</a> &nbsp;·&nbsp; <a href="README.ru.md">Русский</a>
</sub>

</div>

---

## What is pi-rlm?

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

`pi-rlm` brings that paradigm **natively into Pi** — not as a separate agent you must
switch to, but as a plugin you toggle **inside your existing Pi session**:

- A **root orchestrator** model drives a **persistent Python REPL** turn-by-turn.
- Long-context work is **delegated** to cheap worker models via `llm_query` / `llm_batch`.
- Hard sub-problems **recurse** into child RLMs via `rlm_query` (depth-capped). A child
  inherits its parent's `context` — every file loaded so far — at **zero token cost**:
  the content lives in the sandbox; only a size line reaches the model.
- Everything runs **in-process** — the only external process is one local `python3` worker.

> This is a Pi-plugin reimplementation of the RLM method (see the [RLM paper](https://arxiv.org/abs/2512.24601)).
> It is **not** the Python library.

## Why pi-rlm?

### 🔌 Plugin, not a new agent

pi-rlm lives **inside Pi**. You keep your keybindings, your theme, your tools, your
muscle memory. Toggle `/rlm` on — plain prompts now route through the RLM engine.
Toggle it off — Pi is back to normal. No separate CLI, no switching windows, no new
config file.

### 📄 Reads ANY document

Drop any of these into `add_context()` and they auto-convert to Markdown:

| Binary (anydoc native) | Text (UTF-8) | Pandoc fallback |
|------------------------|--------------|-----------------|
| `.pdf` `.docx` `.pptx` | `.csv` `.tsv` | `.doc` `.ppt` `.xls` |
| `.xlsx` `.epub` `.rtf` | `.html` `.htm` | `.pptm` `.xlsm` `.xlsb` |
| `.odt` | `.xml` `.rss` `.atom` | `.ppsm` `.docm` `.odp` `.ods` |

```python
add_context("report.pdf")    # → Markdown in context
add_context("data.xlsx")     # → Markdown in context
add_context("../some-lib")   # → entire directory tree packed
add_context("https://github.com/x/y.git")  # → shallow clone + pack
```

### 🪶 Unix-style — one thing well

pi-rlm implements **only** the RLM algorithm. It doesn't ship a workflow engine,
a skill manager, or a custom TUI. Combine it with `pi-dynamic-workflows` for
orchestration, any skill plugin for capabilities, any theme for looks. No lock-in,
no bloat.

### 🧠 Smart model orchestrates, cheap models research

The root uses your best model. Workers auto-pick the cheapest available. Child RLMs
inherit the full `context` at zero token cost — the sandbox holds the files, the model
only sees a size line. **Recursive delegation → 99% token savings.**

### ⏳ Long-running with goals

Toggle `/rlm` on, set a goal, let it loop. Runs persist across chat turns. The engine
respects depth caps, wall-clock ceilings, token budgets, and consecutive-error limits
so it won't runaway. Come back to a finished answer — or `/rlm-stop` mid-run.

### 🔒 Fully local, fully private

No servers. Your API keys never leave your machine. One `python3` subprocess — that's
the entire infrastructure.

## Benchmarks

Tested against `rlm-lab` prompt bake-off and full dual-mode RLM runtime benchmarks
on a **free** model (`poolside/laguna-xs-2.1:free`, ~32B parameters):

### Prompt bake-off

| Arm | n | Mean score |
|-----|---|-----------|
| **main_v3_fewshot** (orchestrator) | 7 scenarios | **0.958** |
| main_v2_xml_contract | 7 | 0.915 |
| main_v1_split_abstractions | 7 | 0.902 |
| main_v0_baseline | 7 | 0.874 |

| Arm | n | Mean score |
|-----|---|-----------|
| **rlm_v2_completion_contract** (worker) | 4 scenarios | **~0.94** |
| rlm_v1_doctrine | 4 | ~0.82 |
| rlm_v0_baseline | 4 | noisy |

### Full runtime (classic RLM + orchestrator)

| Benchmark | Mode | Result | Tokens |
|-----------|------|--------|--------|
| Needle-in-haystack (3 needles) | classic | **recall 1.0** | ~8.4k |
| CodeQA timeout default | classic | **correct** | ~3.7k |
| CodeQA max retries | classic | **correct** | ~2.6k |
| Coding retry_fix (50→500) | orchestrator | **correct** | — |
| Live smoke needle | classic | **hit** | ~5k |

> Full methodology and raw journals: [`rlm_test/RESULTS.md`](https://github.com/openzebra/rlm_test/blob/master/RESULTS.md)
> and [`rlm_test/RESULTS_AGENT.md`](https://github.com/openzebra/rlm_test/blob/master/RESULTS_AGENT.md).
> All results on a *free* model — frontier models perform even better.

## Install

```bash
pi install npm:@hicaru/pi-rlm
```

To remove it later:

```bash
pi uninstall npm:@hicaru/pi-rlm
```

Then run `/reload` or restart Pi. Verify with `pi list` that the package appears in
`settings.packages`, and check that `/rlm`, `/rlm-config`, and `/rlm-stop` appear under
**[Extensions]**.

Toggle with `Ctrl+Shift+R` or `/rlm` — plain prompts now route through the RLM engine.

## How it works

```
          ┌─────────────────────────┐
          │     Pi coding agent     │
          └────────────┬────────────┘
                       │  /rlm
                       ▼
          ┌─────────────────────────┐  spawns   ┌────────────────────┐
          │  Smart model (root)     │ ────────► │   Worker models    │
          │  drives a Python REPL   │ ◄──────── │   (cheap, fast)    │
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
|---------|----------|-------------|
| `/rlm` | `Ctrl+Shift+R` | Toggle persistent RLM mode (route plain prompts through the RLM engine) |
| `/rlm-stop` | | Abort an in-progress run |
| `/rlm-config` | | Pick smart + worker models and tune run settings |

While a run is active, a **live tree** shows the root orchestrator and every sub-LLM /
recursive child with status, model, cost, tokens, and duration. The final answer is posted
to the chat as markdown; any code edits are collected as diffs and reviewed via a popup
(unless `yolo` is on).

## Sandbox API

These functions are injected into the model's Python namespace inside the REPL:

| Function | Signature | Description |
|----------|-----------|-------------|
| `context` | `list[dict]` | Repository packed as `[{"path","content","tokens"}, ...]` — the full codebase |
| `llm_query` | `(prompt) -> str` | One-shot sub-LLM call (configured RLM LLM) |
| `llm_query_batched` | `(prompts) -> list[str]` | Concurrent sub-LLM calls (pool-bounded) |
| `rlm_query` | `(prompt, paths=None) -> str` | Recursive child RLM with its own sandbox (depth-capped). Inherits your `context`; `paths` narrows it by prefix |
| `rlm_query_batched` | `(prompts, paths=None) -> list[str]` | Concurrent recursive child RLMs, sharing one `paths` slice |
| `SHOW_VARS` | `() -> str` | List currently defined variables & their types |
| `answer` | `dict` | Set `answer["content"]=...; answer["ready"]=True` to finalize |

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---------|---------|---------|
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

## Prompt Architecture

The system prompt follows a **contract / routing / examples / rules** pattern
(api_v5, modeled on the best-performing arm from the RLM paper bake-off):

| Section | Purpose |
|---------|---------|
| `<contract>` | Hard invariant: every heavy call returns a `Task`, never the answer. Only `await_task` returns content. |
| `<routing>` | Decision tree: which tool for which job. Includes negative guidance ("NOT for") so the model knows when NOT to pick a tool. |
| `<examples>` | Concrete E1–E7 patterns: good decompositions alongside anti-patterns with WHY each fails. |
| `<rules>` | Standing orders: locate-then-delegate, memoize into `answers`, cap concurrent workers, author edits yourself. |

Key design decisions:

- **Thinking rule:** the prompt tells the model *when* to plan out loud (complex decomposition,
  uncertain targets) vs. when to jump straight to `repl()` (known paths, cheap lookups).
- **Depth visibility:** child RLMs see `Recursion depth: N` and calibrate ambition — they
  delegate only when their assigned task itself decomposes.
- **Children are sandboxed:** children cannot mutate the parent's `answers`, `plan`, or REPL
  variables. Inheritance is one-way (read-only context).
- **Root tasks wrapped in `<task>` XML tags** so the model cleanly separates user intent
  from system instructions.
- **`answer["ready"]` nudge:** runs that never finalize are wasted — the prompt reinforces
  this with an explicit "You MUST flip" directive.

## Architecture

```
pi-plugin/rlm/src/
├── core/          Headless RLM loop, limits, compaction, history
├── bridge/        Sub-LLM/rlm handlers (single implementation)
│   └── handlers/  llm_query, rlm_query, task registry, emitting
├── sandbox/       Python subprocess (py/), JSONL protocol, interrupt dispatch
├── tool/          repl() and rlm() Pi tool registrations + event emitter
├── config/        rlm.json persistence, defaults, model resolution
├── prompts/       glossary (shared) → system (headless) + native
├── context/       walker + anydoc document conversion + add_context
├── ui/            Config panel, model picker, status line, theme
├── text/          REPL block parsing, token estimation, preview
├── mode/          RlmController, worker-model ranking, native-mode guards
├── util/          Result type, error formatting, concurrency pool
└── commands/      /rlm, /rlm-stop, /rlm-config
```

The engine performs **no disk I/O**. There is no run trail, no snapshot, no resume: a
run lives entirely in memory and its answer is its only durable output.

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
