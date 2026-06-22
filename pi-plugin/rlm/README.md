# pi-rlm — Recursive Language Model for Pi

A [Pi](https://github.com/earendil-works) extension that implements the **Recursive Language Model
(RLM)** method: a root model orchestrates over a *very large* context by driving a persistent Python
REPL, delegating long-context work to sub-LLMs, and recursing into child RLMs for hard sub-problems —
all **natively inside pi, with no extra servers**.

## How it works

```
pi process (TypeScript)
 ├─ /rlm  ──► engine drives the SMART model turn-by-turn (writes ```repl``` Python)
 │             │  each turn: parse repl blocks ──► run in sandbox ──► feed stdout back
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER model (serverless, in-process)
 │            rlm_query ──► recursive child RLM (own sandbox), depth-capped
 ├─ AgentTree ──► live agent/subagent tree above the editor (roles, depth, cost, tokens)
 └─ PythonSandbox ── `python3 worker.py` ──[JSONL over stdio, bidirectional]── persistent REPL
```

- **No servers, no sockets, no Docker.** The only external process is one local `python3` sandbox.
  When sandbox code calls `llm_query`, the worker writes a request on stdout and blocks on stdin;
  pi services it in-process and writes the reply back. **Provider API keys never enter the sandbox.**
- The sandbox exposes `context`, `llm_query`, `llm_query_batched`, `rlm_query`, `rlm_query_batched`,
  `SHOW_VARS()`, and an `answer` dict. The model submits by setting `answer["ready"] = True`.

## Install

Copy this folder to `~/.pi/agent/extensions/rlm` (global) or `.pi/extensions/rlm` (project-local),
then `cd` into it and `npm install`. Requires `python3` on `PATH` (standard library only).

## Usage

```
/rlm <question>                     # run with no preloaded context
/rlm --file a.txt --file b.txt <q>  # load files as a list[str] context
/rlm --paste <question>             # paste a large context into an editor
/rlm-stop                           # abort an in-progress run
/rlm-config                         # pick smart + worker models and tune run settings
```

While a run is active, a live tree shows the root orchestrator and every sub-LLM / recursive child
with status, model, cost, tokens, and duration. The final answer is posted to the chat as markdown.

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---|---|---|
| Smart model | pi's active model | the root orchestrator |
| Worker model | cheapest available | answers `llm_query` |
| Max recursion depth | 2 | `rlm_query` past this falls back to `llm_query` |
| Max iterations | 30 | turns before the engine finalizes |
| REPL block timeout | 120s | per-`repl`-block wall-clock (SIGALRM in the worker) |
| Max concurrent sub-calls | 4 | pool size for `*_batched` |
| Orchestrator addendum | on | "delegate, don't solve" guidance |
| Trajectory compaction | off | summarize history when it nears the context window |

## Security

- Provider keys live only in the pi process; the sandbox environment is sanitized (no `*_KEY`,
  `*_TOKEN`, `ANTHROPIC*`, `OPENAI*`, …) and the sandbox has no channel except its own stdio pipe.
- Restricted builtins (no `eval`/`exec`/`compile`/`input`/`globals`/`locals`); per-block timeout +
  parent watchdog (SIGKILL on hang); budget / token / timeout / consecutive-error caps.
- The subprocess sandbox trusts the root model's Python; it is isolation-agnostic, so a stronger
  jail can be added later behind a setting without changing the protocol.

## Layout

```
src/
  sandbox/   worker.py + JSONL stdio driver (PythonSandbox)
  bridge/    model.ts (one-shot completion) · llm-query.ts · rlm-query.ts (recursion)
  core/      engine.ts (the loop) · iteration · limits · answer · compaction · types
  prompts/   system + per-turn prompts (ported from the Python reference)
  text/      parsing (repl blocks) · tokens · chunking (FFD bin packing)
  state/     agent-tree · events (SubcallObserver)
  ui/        tree-widget · status · model-picker · config-panel · theme
  commands/  rlm · rlm-config
  mode/      rlm-mode (controller)
test/        phase1 (sandbox) · phase2 (bridge) · phase3 (e2e) · phase4 (engine) · phase5 (tree)
```

## Tests

```
bun run test/phase1.ts                  # sandbox: exec, persistence, key isolation, timeout kill
bun run test/phase4.ts                  # recursion depth-cap logic (no tokens)
bun run test/phase5.ts                  # live agent tree rendering (no tokens)
RLM_TEST_LIVE=1 bun run test/phase2.ts  # real llm_query through the sandbox
RLM_TEST_LIVE=1 bun run test/phase3.ts  # real end-to-end /rlm over a file context
RLM_TEST_LIVE=1 bun run test/phase4.ts  # engine solves a 20-doc needle-in-haystack
```

Modeled on the Python reference `rlm` and the method in `books`; reimplemented natively for pi.
