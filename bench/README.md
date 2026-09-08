# bench/ — RLM engine benchmarks

E2E benchmarks for **this project's** RLM engine (`pi-plugin/rlm/src/core/engine.ts`,
the real headless loop + real Python sandbox + real provider I/O). The task suites,
fixtures, and graders are ported from the experimental lab `../rlm_test`
(`src/rlm_agent/bench/{needle,suite}.py` + `benches/`); the lab's Python engine is **not**
used or moved.

## Suite

One suite, on purpose: `oolong` — the only one that can see a regression. Everything else was
pruned (needle/s_niah saturated at 100% for every live model; codeqa/coding were toy tasks;
browsecomp/codeqa_lb needed web-scale downloads for off-signal numbers).

| Suite | Task | Source dataset | Scoring |
|-------|------|----------------|---------|
| `oolong` | Aggregation questions over synth records; rows round-robin across `context_len` buckets (extendable via `--oolong-max-cl` / `--oolong-limit`) | `oolongbench/oolong-synth` | label / numeric / list heuristic (0–1); `recall` = score, `correct` = full score |

Datasets download from HuggingFace on first use and cache in `bench/data/` (gitignored —
delete a file to refetch).

Adaptation vs the lab: this engine's sandbox exposes retrieval + delegation only (no
`write`/`edit` tools — Pi owns mutations by design), so every suite grades the ANSWER.

## Running

The API key travels **via env vars only** — never hardcode it, never commit it.

```bash
export OPENROUTER_API_KEY=sk-or-...        # required
bun run bench/run.ts                       # oolong, default model, 8 tasks @ cl ≤ 2048
bun run bench/run.ts --limit 1             # first task only
bun run bench/run.ts --oolong-max-cl 65536 --oolong-limit 24
                                           # extended oolong: context_len cap / task count
bun run bench/run.ts --model openrouter/google/gemma-3-27b-it
bun run bench/run.ts --list                # print tasks + context sizes, no engine
bun run bench/run.ts --journal bench/runs/foo.jsonl --resume
                                           # crash-safe pooled run: rows already in the
                                           # journal (same model+task+run) are skipped
bun run bench/run.ts --runs 3 --max-iterations 16 --reasoning high \
  --model openrouter/qwen/qwen3.8-27b      # r3-recipe: pooled repeats + thinking arm
```

Optional env vars:

| Var | Default | Meaning |
|-----|---------|---------|
| `RLM_BENCH_MODEL` | `openrouter/google/gemma-3-27b-it` | OpenRouter model under test (cheap paid; a full lite+paper run costs ≈ $0.30). Free pools die mid-stream (`finish_reason:"error"` with no payload). The lab's `laguna-xs-2.1:free` scores 0 — emits `<tool_call>` tags, never a ```repl block |
| `RLM_BENCH_CONTEXT_WINDOW` | `131072` | Advertised context window of the model under test (budget math uses it) |


## Artifacts

- `bench/runs/bench-<ts>.jsonl` — one JSONL row per task: `suite, taskId, model, correct,
  recall, answer, gold, error, latencyMs, inputTokens, outputTokens, iterations, costUsd`
  (mirrors the lab's journal schema). Journal only — no aggregate report is written.

## Engine wiring (bench/engine.ts)

`makeRun()` builds `createEngine` deps exactly like the mock fixtures in
`pi-plugin/rlm/test/helpers.ts`, but pointed at OpenRouter: a `Model<Api>` row with
`provider: "openrouter"`, `api: "openai-completions"`, `baseUrl: https://openrouter.ai/api/v1`,
and a registry whose `getApiKeyAndHeaders` returns the env key at call time. No `complete`
override → the engine uses `modelComplete` (real `completeSimple` + retry/throttle).

Bench config: `maxIterations 16`, `maxConcurrentSubcalls 4`, `enableMemory false`,
`autoSeedCwd false`, `rootSampling.maxTokens 4096`, `subSampling.maxTokens 2048`,
`enableTokenBudget false` (the cascade caps a task at ~25% of the context window — below the
raw context of paper-tier tasks; it is unit-tested separately in `pi-plugin/rlm/test/budget.ts`).

Not ported from the lab: `api_suite` / `mem_suite` / `e2e_v2–v4` (they test lab-only engine
internals — orchestrator tool-recall traces, ledger/memory units, budget governor events —
which this project covers with its own `pi-plugin/rlm/test/` suites).
