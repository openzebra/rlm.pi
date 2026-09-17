<div align="center">

# rlm.pi

**Recursive Language Models for Pi — million-token context on cheap models.**

Your model reads big documents with huge context — <b>at high accuracy</b>.

<p>
<a href="https://www.npmjs.com/package/@hicaru/pi-rlm"><img src="https://img.shields.io/npm/v/@hicaru/pi-rlm?color=cb3837&label=npm" alt="npm" /></a>
<a href="https://github.com/openzebra/rlm.pi/actions"><img src="https://img.shields.io/badge/OOLONG-91.7%25-brightgreen" alt="OOLONG 91.7%" /></a>
<a href="https://arxiv.org/abs/2512.24601"><img src="https://img.shields.io/badge/arXiv-2512.24601-b31b1b" alt="RLM paper" /></a>
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
</p>

<img src="assets/hero.png" width="92%" alt="rlm.pi — OOLONG benchmark results" />

<sub><b>English</b> · <a href="README.zh-CN.md">中文</a> · <a href="README.ru.md">Русский</a></sub>

</div>

## Get started

```bash
pi install npm:@hicaru/pi-rlm        # Pi
omp plugin install @hicaru/pi-rlm    # oh-my-pi
```

Then `/reload` (or restart). Verify `/rlm`, `/rlm-config`, `/rlm-stop` appear under
**[Extensions]**, and toggle with `Ctrl+Shift+R` or `/rlm` — plain prompts now route
through the RLM engine.

| | install | upgrade | remove |
|---|---|---|---|
| **Pi** | `pi install npm:@hicaru/pi-rlm` | `pi install npm:@hicaru/pi-rlm --force` | `pi uninstall npm:@hicaru/pi-rlm` |
| **oh-my-pi** | `omp plugin install @hicaru/pi-rlm` | `omp plugin install @hicaru/pi-rlm --force` | `omp plugin uninstall @hicaru/pi-rlm` |

## The idea

Instead of stuffing the context into the prompt, the context **lives in the sandbox** —
files, PDFs, repos, session logs — and the model sees only an index. Each step is one
state transition:

```
A_t = (P, Σ_t, O_t)          fixed prompt + execution state Σ_t + tool surface
ΔΣ_t = μ(A_t)                the model emits a repl() patch, not prose
V(ΔΣ_t, Σ_t)                 deterministic validator — no crash paths
Σ_{t+1} = Σ_t ⊕ ΔΣ_t         deep merge, null = delete (paper §5.7)
```

The smart model orchestrates (`P`); cheap workers pay for the reading (`llm_query`,
`rlm_query`); hard sub-problems recurse into child RLMs — depth-capped, budgeted, and
each child inherits the full sandbox at zero token cost. Runs persist across chat
turns; durable progress is committed as `Σ` deltas validated by the same ladder every
step. Native sessions get the **Root Σ** layer for free: elided turns fold into a
session archive, `/compact` becomes a deterministic structural digest, and the
skill store `Ξ` re-ranks project facts into every prompt.

## Benchmarks

Full **OOLONG** suite (oolong-synth, 24 tasks, context up to 128K tokens), latest
journal per model, cost from real `costUsd`:

| Model | OOLONG | avg tokens/task | cost/task |
|---|---|---|---|
| `zai/glm-4.7` | **91.7%** (22/24) | ~36k | ~$0.00 \* |
| `openrouter/qwen/qwen3.8-27b` | 49% | ~36k | $0.10 |
| `openrouter/inception/mercury-2.5` | 38% | ~36k | $0.005 |

\* Z.ai coding-plan endpoint — subscription billing, so `costUsd` stays $0.

In the [RLM paper](https://arxiv.org/abs/2512.24601), GPT-5-mini driven as an RLM
outperforms GPT-o3 on OOLONG — recursion beats raw context, at a fraction of the price.

Raw per-task rows live in [`bench/runs/*.jsonl`](bench/runs/). Reproduce:

```bash
export OPENROUTER_API_KEY=sk-or-...    # or ZAI_API_KEY for zai/*
bun run bench --model zai/glm-4.7 --oolong-max-cl 65536 --oolong-limit 24
```

## What you get

| | pi-rlm gives you |
|---|---|
| **Research** | Map-reduce over repos, PDFs, logs — workers read, your model thinks. |
| **Big context** | The sandbox holds it all at zero prompt cost; the model sees an index. |
| **Token savings** | Workers pick the cheapest model available; reading never touches your main model. |
| **Long runs** | Goals loop across turns with depth caps, budgets, and error limits — come back to a finished answer. |
| **Plugin, not an agent** | Lives inside Pi/omp: your theme, tools, keys, muscle memory. Toggle `/rlm` on and off. |
| **Reads anything** | `add_context("report.pdf")` — PDF, DOCX, XLSX, EPUB, CSV, HTML → Markdown, no preprocessing. |

## How it works

```
 you ──► prompt ──► RLM engine ──► smart model (turn-by-turn, Python in repl())
                          │              │  search / grep / outline  (free)
                          │              ├─► llm_query ──► cheap workers
                          │              └─► rlm_query ──► child RLMs (depth-capped)
                          └──► Σ_t state + validation + budgets (tokens, wall-clock, errors)
```

- The **smart model** thinks and writes Python in a REPL.
- The **worker models** do the heavy lifting (read, summarize, classify).
- Hard sub-problems **recurse** into child RLMs.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/rlm` | `Ctrl+Shift+R` | Toggle RLM mode (route plain prompts through the engine) |
| `/rlm-stop` | | Abort an in-progress run |
| `/rlm-config` | | Sampling, budgets, paradigm flags |

## Sandbox API

The model-visible surface is deliberately small — retrieval and delegation only:

```python
search("needle", k=10)            # BM25 pointers into the context
grep_context(pattern, k=50)       # regex hits with line numbers
outline(path)                     # definition skeleton
add_context("report.pdf")         # attach + auto-convert any document
llm_query(prompt)                 # cheap worker, text in → text out
map_files(paths, prompt)          # same question over many files
rlm_query(task, paths=...)        # recursive child RLM
answers / plan                    # persistent memory across turns
```

## Security

- The engine performs **no disk I/O** — a run lives in memory; its answer is the only durable output.
- API keys never enter the sandbox: sub-LLM calls are serviced host-side by bridges.
- Python runs in a guarded subprocess with a reserved-name allowlist and interrupt dispatch.

## License

[MIT](pi-plugin/rlm/LICENSE) © hicaru contributors
