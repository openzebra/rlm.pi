<p align="center">
  <img src="https://github.com/openzebra/rlm.pi/blob/master/assets/plugin-cover.png?raw=true" width="100%" alt="pi-rlm — Recursive Language Model plugin for Pi">
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
recursive orchestration engine — your best model orchestrates, cheap worker models
do the reading.

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

## Sampling & reproducibility

The r3 bench showed the biggest capability lever is not the model — it is the sampling:
temperature 0 took OOLONG from 71% pooled / 40% flips to 91.7–100% all-stable for $1.74
total. Those knobs are first-class in `rlm.json` (`~/.pi/agent/rlm.json`) and on the
`/rlm-config` panel:

| Field | Where | Default | What it governs |
|-------|-------|---------|-----------------|
| `rootSampling.maxTokens` | rlm.json, panel | `16384` | Output cap per root-model turn (finalize included) |
| `rootSampling.temperature` | rlm.json, panel | provider default | Root + finalize sampling temperature; `0` = deterministic |
| `smartReasoning` | rlm.json, panel | none | Thinking effort for the root model |
| `subSampling.maxTokens` | rlm.json, panel | `8192` | Output cap per leaf sub-call (`llm_query`, `llm_batch`, `map_files`) |
| `subSampling.temperature` | rlm.json, panel | provider default | Leaf sampling temperature |
| `enableVerificationNudge` | rlm.json | off | One coached redo when the root finalizes early with a bare number / short label |

**Reproducibility recipe (validated by r3):**

```json
{
  "config": {
    "rootSampling": { "maxTokens": 8192, "temperature": 0, "reasoning": "high" }
  }
}
```

Reasoning tokens share the completion budget with the answer — with thinking on, keep
`maxTokens` generous (the bench doubles it to 8192; the engine warns once on turn 0 when it
is tight).

**Scope boundary:** `rlm.json` sampling applies to RLM-mode runs, `rlm()` delegation, and
child recursion at any depth (same engine function). The native Pi agent loop follows Pi's
own session settings — rlm.json never touches it.

**Model capability:** reasoning requires a model whose registry entry has `reasoning: true`.
Anything else has the level dropped before it reaches the provider (pi-ai clamps unsupported
levels to off); capability comes from the registry, never from config.

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

E2E runs of the real engine against OpenRouter chat models — the lite suite
(`needle` multi-needle recall, `codeqa` repo-QA, `coding` fix task; 7 tasks × 2 passes
per model). Deterministic graders (recall / gold containment / regex), no LLM-as-judge.

Latest results — small models (≤32B parameters, paid tier):

| Model | Params | Score | Accuracy | Latency/task |
|-------|--------|-------|----------|--------------|
| `qwen/qwen3-30b-a3b-instruct-2507` | MoE 30B / 3B active | **14/14** | **100%** | ~15s |
| `google/gemma-3-27b-it` | dense 27B | 12/14 | 86% | ~26s |
| `mistralai/mistral-small-3.2-24b-instruct` | dense 24B | 12/14 | 86% | ~28s |

Raw per-task rows (correct, recall, latency, tokens, cost) live in
`bench/runs/bench-<ts>.jsonl` — one JSONL row per task, committed as history.

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
`oolong` · `browsecomp` · `codeqa_lb`.

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
