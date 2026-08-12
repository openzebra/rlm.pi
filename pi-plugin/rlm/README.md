<p align="center">
  <img src="https://raw.githubusercontent.com/openzebra/rlm.pi/master/assets/plugin-cover.png" width="100%" alt="pi-rlm — Recursive Language Model plugin for Pi">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hicaru/pi-rlm"><img src="https://img.shields.io/npm/v/@hicaru/pi-rlm?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/openzebra/rlm.pi/blob/master/pi-plugin/rlm/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/for-Pi-7c3aed" alt="Built for Pi"></a>
</p>

<p align="center">
  <a href="https://arxiv.org/abs/2512.24601">📄 RLM Paper</a> ·
  <a href="https://github.com/openzebra/rlm.pi">💻 Source</a> ·
  <a href="https://www.npmjs.com/package/@hicaru/pi-rlm">📦 npm</a>
</p>

---

**The ONLY Recursive Language Model plugin for Pi.** No new agent to learn, no
separate CLI, no YAML workflows — just `/rlm` and your existing Pi session becomes a
recursive orchestration engine that saves **99% tokens** by delegating work to cheap
worker models.

> **One install. One toggle. Infinite context.**

## Why pi-rlm?

| Advantage | What it means |
|-----------|---------------|
| 🔌 **Plugin, not a new agent** | Stays inside Pi. You keep your keybindings, your theme, your tools, your muscle memory. |
| 📄 **Reads ANY document** | `.pdf` `.docx` `.pptx` `.xlsx` `.epub` `.rtf` `.odt` `.csv` `.html` `.xml` — drop them in, they become Markdown in `context`. |
| 🪶 **Unix-style — tiny & composable** | Does ONE thing (RLM orchestration). Pair it with any other Pi plugin. No lock-in. |
| 🧠 **Smartest model orchestrates, cheapest model researches** | Root uses your best model; workers auto-pick the cheapest. Recursive children inherit the full `context` for free. |
| ⏳ **Long-running with goals** | Toggle `/rlm` on, set a goal, let it loop. Runs survive across chat turns — go make coffee. |
| 🔒 **100% local, 100% private** | No servers. Your API keys never leave your machine. One `python3` subprocess — that's it. |

## See it in action

<div align="center">

<video src="https://github.com/openzebra/rlm.pi/raw/refs/heads/master/animation/rlm_pi_explainer.mp4" controls width="854" poster="https://raw.githubusercontent.com/openzebra/rlm.pi/master/assets/hero.png"></video>

</div>

## Install (30 seconds)

```bash
pi install npm:@hicaru/pi-rlm
```

Run `/reload` in Pi. Done. `/rlm`, `/rlm-config`, `/rlm-stop` appear under **[Extensions]**.

Toggle with `Ctrl+Shift+R` or `/rlm` — plain prompts now route through the RLM engine.

## What you get

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

- **Smart model** thinks and writes Python in a persistent REPL.
- **Worker models** do the heavy lifting — read, summarize, classify, search.
- **Child RLMs** recurse into hard sub-problems, inheriting the full `context` for free.
- **Live tree** shows every sub-call with model, cost, tokens, and duration.

## Document format support

Drop ANY of these into `add_context()` — they auto-convert to Markdown and land in `context`:

| Category | Formats |
|----------|---------|
| **Word** | `.docx` |
| **PDF** | `.pdf` |
| **PowerPoint** | `.pptx` |
| **Excel** | `.xlsx` |
| **EPUB** | `.epub` |
| **Rich Text** | `.rtf` |
| **OpenDocument** | `.odt` |
| **CSV / TSV** | `.csv` `.tsv` |
| **HTML / XML** | `.html` `.htm` `.xml` `.rss` `.atom` |
| **+ Pandoc fallback** | `.doc` `.ppt` `.xls` `.pptm` `.xlsm` `.xlsb` `.ppsm` `.docm` `.odp` `.ods` |

```python
add_context("report.pdf")   # → Markdown in context
add_context("data.xlsx")    # → Markdown in context
add_context("../some-lib")  # → entire directory packed
add_context("https://github.com/x/y.git")  # → shallow clone + pack
```

## RECURSION — the core idea

A **Recursive Language Model (RLM)** replaces `llm.completion(prompt)` with
`rlm.completion(prompt)`. The prompt becomes a variable in a REPL. The model can
launch sub-LLM and sub-RLM calls as ordinary Python functions — decomposing,
delegating, and synthesizing across a tree of models, not a single context window.

**This is the only plugin that brings true RLM recursion to Pi.** Prime Agent and
the reference Python library are separate agents you must switch to. pi-rlm lives
inside Pi — same session, same tools, same everything.

## Commands

| Command | Shortcut | What it does |
|---------|----------|--------------|
| `/rlm` | `Ctrl+Shift+R` | Toggle RLM mode on/off |
| `/rlm-stop` | | Abort current run |
| `/rlm-config` | | Pick models, tune limits |

## Settings (`/rlm-config`)

| Setting | Default | Why you'd change it |
|---------|---------|---------------------|
| Smart model | Pi's active | Use your best model as orchestrator |
| Worker model | cheapest available | Free/cheap model for leaf `llm_query` calls |
| Max recursion depth | `4` | Deeper trees for harder problems |
| Max iterations | `30` | Longer runs for complex tasks |
| REPL timeout | `120`s | Bump for slow computations |
| Max concurrent subs | `16` | More parallelism (costs RAM) |

## Prompt Architecture

The system prompt follows a **contract / routing / examples / rules** pattern
(api_v5), modeled on the best-performing arm from the RLM paper bake-off:

- `<contract>` — every heavy call returns a `Task`, only `await_task` returns content
- `<routing>` — decision tree: which tool for which job
- `<examples>` — concrete E1–E7 patterns with anti-patterns
- `<rules>` — locate-then-delegate, memoize, cap workers, author edits yourself

**Key insight:** children see `Recursion depth: N` and calibrate ambition —
delegating only when their task genuinely decomposes further.

## Benchmarks

Tested against `rlm-lab` prompt bake-off and full dual-mode RLM runtime benchmarks
on `poolside/laguna-xs-2.1:free` (a free ~32B model):

| Benchmark | Mode | Result |
|-----------|------|--------|
| Main orchestrator (7 scenarios) | prompt bake-off | **0.958** mean score (v3 fewshot arm) |
| RLM worker (4 scenarios) | prompt bake-off | **0.94** mean score (v2 contract arm) |
| Needle-in-haystack (3 needles) | classic RLM | **recall 1.0** |
| CodeQA timeout | classic RLM | **correct** (~3.7k tokens) |
| Coding (retry fix) | orchestrator | **correct** (file edited) |
| Live smoke needle | classic RLM | **hit** (~5k tokens) |

> On a *free* model. Frontier models do even better. See `rlm_test/RESULTS_AGENT.md`
> and `rlm_test/RESULTS.md` for full methodology.

## Security

- **Key isolation** — provider keys live in TypeScript only; sandbox receives prompts, returns text.
- **Environment sanitization** — sensitive env vars stripped before worker spawns.
- **Restricted builtins** — no `eval`/`exec`/`compile`/`input` in the sandbox.
- **Per-block timeout** — SIGALRM + parent watchdog (SIGKILL on hang).
- **Trust** — project-local install requires Pi project trust.

## Uninstall

```bash
pi uninstall npm:@hicaru/pi-rlm
```

## License

MIT — see [LICENSE](./LICENSE).
