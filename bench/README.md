# bench/ — RLM engine benchmarks

E2E benchmarks for **this project's** RLM engine (`pi-plugin/rlm/src/core/engine.ts`,
the real headless loop + real Python sandbox + real provider I/O). The task suites,
fixtures, and graders are ported from the experimental lab `../rlm_test`
(`src/rlm_agent/bench/{needle,suite}.py` + `benches/`); the lab's Python engine is **not**
used or moved.

## Suites

| Suite | Task | Grading (deterministic, no LLM-as-judge) |
|---------|------|------------------------------------------|
| `needle` | Multi-needle recall over padded haystacks (1 short / 3 medium / 2 large ~50k chars) | token recall of planted needles |
| `codeqa` | 3 questions over a packed mini repo (`fixtures/codeqa/repo_http`) | gold-substring containment |
| `coding` | Fix `DEFAULT_TIMEOUT_MS 50 → 500` in `retry_fix` | regex on the **answer** |

Paper tier (same scale-down as the lab's `rlm-agent paper`; datasets download from HuggingFace
on first use and cache in `bench/data/`, gitignored — delete a file to refetch):

| Suite | Task | Source dataset | Scoring |
|-------|------|----------------|---------|
| `s_niah` | Single needle at 8k/16k/32k/64k-char buckets (n=4) | synthetic (seed 42) | substring recall |
| `oolong` | Aggregation questions over synth records, `context_len ≤ 2048` (n=8); extendable via `--oolong-max-cl` / `--oolong-limit` (rows round-robin across context_len buckets) | `oolongbench/oolong-synth` | label / numeric / list heuristic (0–1) |
| `browsecomp` | Deep-research QA: decrypted query + gold/evidence + ≤20 negatives, ≤400k chars (n=4) | `Tevatron/browsecomp-plus` | containment or token-overlap (0–1) |
| `codeqa_lb` | LongBench-v2 code-repo MCQ, short/medium, ≤200k chars (n=3) | `THUDM/LongBench-v2` | exact letter A–D |

`--suite paper` runs the whole paper tier; `--suite all` runs only the offline lite tier.
For score suites `recall` in rows/report is the heuristic score and `correct` means full score.

Adaptation vs the lab: this engine's sandbox exposes retrieval + delegation only (no
`write`/`edit` tools — Pi owns mutations by design), so the coding suite grades the answer
instead of verifying a file on disk.

## Running

The API key travels **via env vars only** — never hardcode it, never commit it.

```bash
export OPENROUTER_API_KEY=sk-or-...        # required
bun run bench/run.ts                       # lite suites, default free model
bun run bench/run.ts --suite needle        # needle|codeqa|coding (offline)
bun run bench/run.ts --suite paper         # s_niah + oolong + browsecomp + codeqa_lb (downloads data on first run)
bun run bench/run.ts --suite s_niah        # one paper suite
bun run bench/run.ts --suite oolong --oolong-max-cl 65536 --oolong-limit 24
                                           # extended oolong: cap context_len units, more tasks
bun run bench/run.ts --limit 1             # first task per suite
bun run bench/run.ts --list                # offline: print tasks, no engine
bun run bench/run.ts --model openrouter/google/gemma-4-31b-it:free
bun run bench/run.ts --journal bench/runs/my-run.jsonl
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
