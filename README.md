# rlm.pi PI plugin

> pi-rlm — Large contexts on cheap models: Recursive Language Model (RLM) for Pi

<div align="center">

<sub>
<b>English</b> &nbsp;·&nbsp; <a href="README.zh-CN.md">中文</a> &nbsp;·&nbsp; <a href="README.ru.md">Русский</a>
</sub>

</div>

---

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

<p align="center">
  <img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" width="100%" alt="rlm.pi — OOLONG benchmark results">
</p>

## What is pi-rlm?

`pi-rlm` brings the **Recursive Language Model (RLM)** paradigm natively into Pi: instead of
stuffing a huge document into the prompt, the context lives in a Python REPL and your best
model orchestrates it — searching, decomposing, and delegating leaf reads to cheap worker
models, recursively. Same Pi session, same tools, same keys — toggle `/rlm` and go.
Modeled on the method in the [RLM paper](https://arxiv.org/abs/2512.24601); details in
**How it works** below.

## Benchmarks

<p align="center">
  <img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" width="100%" alt="OOLONG benchmark — latest results">
</p>

**OOLONG (oolong-synth)** — paper-tier long-context suite; latest journal per model,
cost per task from real `costUsd` (older journals estimated at OpenRouter list prices):

| Model | Score | Avg. cost/task |
|-------|-------|----------------|
| `qwen/qwen3.8-27b` | **100%** | $0.0127 |
| `google/gemma-3-27b-it` | 83.3% | $0.0013 |
| `qwen/qwen3-30b-a3b-instruct-2507` | 66.7% | $0.0009 |
| `mistralai/mistral-small-3.2-24b-instruct` | 66.7% | $0.0025 |

Lite suite — `needle` multi-needle recall, `codeqa` repo-QA, `coding` fix task
(7 tasks × 2 passes per model, deterministic graders, no LLM-as-judge):

| Model | Score | Accuracy |
|-------|-------|----------|
| `qwen/qwen3-30b-a3b-instruct-2507` | **14/14** | **100%** |
| `google/gemma-3-27b-it` | 12/14 | 86% |
| `mistralai/mistral-small-3.2-24b-instruct` | 12/14 | 86% |

Raw per-task rows (correct, recall, latency, tokens, cost) live in
`bench/runs/*.jsonl` — one JSONL row per task, committed as history.

### Run the benchmarks

```bash
export OPENROUTER_API_KEY=sk-or-...        # required — env vars are the only key transport

bun run bench                              # lite suite: needle + codeqa + coding
bun run bench --suite needle --limit 1     # one suite, first task only
bun run bench --model openrouter/qwen/qwen3-30b-a3b-instruct-2507
bun run bench --list                       # print tasks, no engine / no key
bun run bench --suite paper                # paper tier: s_niah, oolong, browsecomp, codeqa_lb (downloads datasets)
```

Suites: `all` (lite, default) · `needle` · `codeqa` · `coding` · `paper` · `s_niah` ·
`oolong` · `browsecomp` · `codeqa_lb`. Regenerate the hero chart:
`python3 bench/hero.py` (needs `matplotlib`).

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
only sees a size line. **Recursive delegation → cheap workers pay for the reading, not your main model.**

### ⏳ Long-running with goals

Toggle `/rlm` on, set a goal, let it loop. Runs persist across chat turns. The engine
respects depth caps, wall-clock ceilings, token budgets, and consecutive-error limits
so it won't runaway. Come back to a finished answer — or `/rlm-stop` mid-run.

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
```

- The **smart model** thinks and writes Python in a REPL.
- The **worker models** do the heavy lifting (read, summarize, classify).
- Hard sub-problems **recurse** into child RLMs.

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
├── config/        rlm.json persistence, defaults, sampling knobs, model resolution
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
