# RLM v5 Port — Re-audit of claimed fixes

**Date:** 2026-04-11 (same day as `RLM_V5_AUDIT.md`)
**Scope:** every Critical / High / Medium from the first audit, plus regressions the fixes introduced
**Method:** read the composition roots and the five v5 modules; re-ran the suites that lock those fixes
**No production code changed**

---

## Verdict

**The previous ship blockers are actually fixed.** This is no longer “libraries landed, product unwired.” Both composition roots share one `MemoryStore` and one `buildSessionGates` resolver; `childRun` emits one node; native `repl()` `beginRun`s; continuations harvest real REPL stdout; delegation children are no longer taught `search(`; the child gate caps the **smart** provider.

I re-ran:

| Suite | Result |
|---|---|
| `test/composition.ts` | ALL PASS |
| `test/budget.ts` | ALL PASS (includes C4 / H2 / H8 gates) |
| `test/ledger.ts` | ALL PASS |
| `test/memory.ts` | ALL PASS |
| `test/concurrency-provider.ts` | ALL PASS |
| `test/child-surface.ts` | ALL PASS (includes C5 prompt greps) |

`test/smoke.ts` now lists `composition.ts`. I did not re-run the full 26-suite smoke this pass.

**It is still not “every finding closed.”** The remaining defects are smaller, but two of them are real product bugs (continuation UI answer dropped; native echo ancestor is the Python cell, not the user task). Do not treat the plan’s “ALL PHASES LANDED / every audit row done” table as fully true.

---

## Previous Criticals

| ID | First-audit claim | Status | Evidence |
|---|---|---|---|
| **C1** | `RlmController.start()` drops memory + capped gates | **FIXED** | `buildEngine` is the one seam; passes `memory: this.memory` and `gates: this.sessionGates?.()`. `index.ts` `setSessionGates(resolveSessionGates)` with memo on `(config, smart, worker)`. `repl()` gets the same resolver via `resolveGates`. |
| **C2** | every successful `rlm_query` emits two UI nodes | **FIXED** | One `emitSubcallCreated` before the decision branch; echo/coalesce/run all reuse `subId`. |
| **C3** | native `repl()` never `beginRun`s | **FIXED, weaker than specified** | `beginRun(params.code)` / `endRun` in `finally` around `execWithSetup`. Echo now has *an* ancestor. That ancestor is the **Python cell**, not the user question. See Remaining / R1. |
| **C4** | continuation handoff drops all REPL state | **FIXED** | `formatReplOutputs` prefixes `REPL stdout:\n`. `distillTrajectory` reverses findings/states to chronological; next-step still newest-first. `test/budget.ts` now runs distill through the real formatter. |
| **C5** | child prompt still teaches `search` | **FIXED at the taught-API bar** | `replGlossary(..., delegation)` swaps retrieval lines for `DELEGATION_SURFACE_LINES`, uses `SPAWN_EXAMPLE_DELEGATION` / `RECURSION_DELEGATION_LINES`, skips `add_context`. Child-surface tests grep `search(` / `grep_context(` out of the child system prompt. Residual: `ENV_TIPS` still names `` `search` `` (no paren) for children. See R3. |
| **C6** | child gate capped against the worker | **FIXED** | `buildSessionGates(config, smartProvider, workerProvider)` → leaf = worker only, child = smart only. Memo rebuilds when `/rlm-config` replaces the config object. Tests lock both peaks at 4. |

C1’s test (`ProbeController`) stubs `buildEngine` and asserts controller fields, not that `createEngine({...})` received them. Production `buildEngine` does pass them — I read the call. The test would stay green if someone deleted the two fields from `createEngine`. Worth tightening; not a product bug.

---

## Previous Highs

| ID | Status | Notes |
|---|---|---|
| **H1** wait-forever | **FIXED** | `waitFor(key, timeoutMs = 600_000)`; rejects immediately on `error`; timer cleared on settle. |
| **H2** continuation persist key | **FIXED** | Leaf with `input.budget` does not persist. Parent `persistRoot(chained.answer)` under the **original** `rootKey`. Stopped/aborted/`(stopped…)` skipped. Budget suite asserts replay on the original key. |
| **H3** batches skip ledger | **FIXED for `llm_query` / `llm_batch`** | Shared `runClaimedLeaf`. Worker `map_files` / `llm_query_chunked` fan out as `llm_batch` / `llm_query` interrupts, so they inherit it. `rlm_query→llm` demotion still calls `complete1` directly — see R4. |
| **H4** never `"running"` | **FIXED** | `markRunning` replaces the frozen claim. Called from `childRun` and `runClaimedLeaf`. |
| **H5** `Claim` not readonly | **FIXED** | All fields `readonly`; transitions `Object.freeze({ ...claim, status })`. |
| **H6** root replay no path hashes | **FIXED** | `rootContextPaths` snapshots un-prefixed cwd files (skips `ctx/` and abs paths), bounded. |
| **H7** fake stream + traversal | **FIXED** | `fileSha256` is `readSync` 64KiB; `safeAbs` jail. |
| **H8** `maxTokens` still throws | **DOCUMENTED, not changed** | Correct: it is a hard abort. `RlmConfig.maxTokens` comment says so. Default remains unset. |
| **H9** continuation drops parent spend / stale context | **MOSTLY FIXED; new hole** | `context: liveContext` forwarded. Tokens/cost folded `inner + parent.usage()`. **`lastAnswer` is not assigned on the continuation return.** See R2. |

---

## Previous Mediums

| ID | Status |
|---|---|
| M1 `observe()` unused | Unchanged. Cache stays empty in prod. Accepted. |
| M2 consolidate race | **Mostly fixed.** Single-flight promise. **Clear-all still races:** `doConsolidate` snapshots `this.pending` then later sets `this.pending = []`, wiping keys appended *during* the LLM call. Those episodes never become notes. See R5. |
| M3 `memoryDir: null` | Doc-only. Constructor still has `enabled && opts.dir !== null`; `index.ts` still does `config.memoryDir ?? undefined`, so `null` never arrives. Harmless. |
| M4 two ledgers | Documented. MemoryStore is shared. Fine. |
| M5 child `add_context` handler | **FIXED.** Installed only when `depth === 0 \|\| childSurface !== "delegation"`. |
| M6 prompt dialects | Mostly. `memory.*` / `list_claims` now in both glossaries. `ENV_TIPS` still mentions search (R3). |
| M7 `subSampling` freeze | Claimed in the plan epilogue; not re-verified line-by-line this pass. |
| M8 `as Record` | `isRecord` guard added in memory / used in `rootContextPaths`. Consolidate JSON items still `as Record<string, unknown>` after an `typeof === "object"` check. Fine. |
| M9 missing composition tests | **Added**, but C1’s test does not open `createEngine`. C2 emit-count is not asserted (I verified by reading `childRun`). |
| M10 secrets warning | Present in native + headless memory lines. |

---

## Remaining findings (this pass)

### R1 — Medium. Native echo ancestor is the Python cell

```322:337:pi-plugin/rlm/src/tool/repl-tool.ts
        const ledgerActive = getConfig().enableLedger;
        if (ledgerActive) sessionLedger.beginRun(params.code);
        ...
        } finally {
          if (ledgerActive) sessionLedger.endRun();
        }
```

`normalizePrompt` + Jaccard over a cell like `t = rlm_query("study auth")\nprint(await_task(t))` is dominated by Python tokens (`print`, `await_task`, `rlm_query`). A child whose prompt is the user’s actual goal often scores **below** 0.8 against that soup.

The engine path still `beginRun(input.rootPrompt)` — correct. Native is the path the first audit said was dead; it is now *on*, but it will miss the echoes the feature exists for, except when the child prompt is almost a copy of the cell.

`endRun` in the cell `finally` also pops the ancestor while **detached** children are still running. That is fine for the child’s own `beginRun`, but a grandchild cannot echo the native cell once the cell has returned.

**Fix:** `beginRun` a stable native-task string (the user turn text, or a extracted `rlm_query(...)` prompt), not the raw cell. Or keep the cell *and* the last user message. Add a test: cell `t = rlm_query("study the payment flow end to end")` must echo.

### R2 — Medium / High. Continuation success leaves `lastAnswer` empty

```408:429:pi-plugin/rlm/src/core/engine.ts
              const inner = await run({ ...input, rootPrompt: continuationPrompt(...), context: liveContext, budget: cont, ... });
              const chained: RlmResult = { ...inner, iterations: ..., inputTokens: inner + u, ... };
              persistRoot(chained.answer);
              return chained;
```

No `lastAnswer = chained.answer` (and no `lastAnswer` on the early `final != null` path before a hard cap either — that path *does* set it at line 376). The continuation path returns past the assignment at 436.

`finally` then:

```456:464:pi-plugin/rlm/src/core/engine.ts
        emitter.emitSubcallUpdated({ ..., resultPreview: nodeStatus === "error" ? undefined : previewText(lastAnswer) });
        ...
        if (nodeStatus !== "error" && lastAnswer) emitter.emitAnswer(previewText(lastAnswer));
```

On a budget-capped root run the engine emits **done with no answer preview**. `rlm-tool.ts` emits `emitAnswer(result.answer)` *after* `await done`, so the card usually fills a tick later. Headless / child-engine consumers that only watch the emitter see a blank. Child `childRun` overwrites the preview after `run()` resolves, so recursive children recover.

Episode `tokensIn` / `tokensOut` on that persist still come from the **parent** `limits.usage()`, not `chained`. Replay cost stats will under-count the leaf.

**Fix:** `lastAnswer = chained.answer` before return; persist `tokensIn: chained.inputTokens` (or pass them into `persistRoot`). One budget-suite assert on the emitter / `lastAnswer` is enough.

### R3 — Low. Delegation children still see `ENV_TIPS` naming search

`buildRlmSystemPrompt` still appends full `ENV_TIPS` when `orchestrator` is on (default). The doctrine says “locate targets with `` `search` `` when your surface has it”. The C5 test only bans `search(`. Runtime is safe; a literal child can still decide to try `search`.

**Fix:** pass a delegation-flavored `ENV_TIPS` (the file already hedges; just drop the name).

### R4 — Low. Demoted `rlm_query→llm` bypasses the ledger

```243:269:pi-plugin/rlm/src/bridge/handlers/rlm-query.ts
      return spawnAndRun(..., () => emitting(..., (track) => complete1(inv, task, track, ...)));
```

After `rlmBudget` the extra calls are plain `complete1`. Identical demoted prompts pay N times. Route through `runClaimedLeaf`.

### R5 — Low / Medium. `doConsolidate` wipes pending appended mid-flight

Single-flight stops a second LLM call. The in-flight run still does `this.pending = []` at the end. Any `recordEpisode` that landed while the LLM was out is dropped from the consolidate queue (the episode itself is on disk; it just never becomes an L2 note until something else triggers a later batch — and that later batch only sees *new* pending keys).

**Fix:** snapshot `const batch = this.pending` at start; at end `this.pending = this.pending.filter(k => !batch.includes(k))`.

### R6 — Low. Uncapped engine fallback still exists

```175:176:pi-plugin/rlm/src/core/engine.ts
      gates: deps.gates
        ?? createSubcallGates(deps.config.maxConcurrentSubcalls, deps.config.maxConcurrentChildren),
```

If `setSessionGates` is skipped (test, or `session_start` bailing before the `llmModel && model` block), the `rlm` tool is back to uncapped private gates. Composition test *blesses* that fallback. Production `session_start` does set it. Don’t delete the fallback; don’t claim C1 is tested at `createEngine`.

### R7 — Low. C1 test does not pin `createEngine` arguments

`ProbeController.buildEngine` never calls `super.buildEngine`. A future edit can drop `memory` / `gates` from `createEngine` and `composition.ts` stays green. Spy the real call or call `super` and intercept `createEngine`.

---

## What I would not reopen

- Fresh `TokenBudget` + `observeTotal` instead of v5 `offset`. Still correct.
- SettingsList row for provider caps. Still the right skip.
- `childSurface: "legacy"` rollback. Still works; `phase4.ts` still pinned.
- `map_files` on the child surface. Still delegation, not retrieval.
- `maxTokens` remaining a hard abort. Documented; default off.
- Offline-only model cache.

---

## Phase scores (after the fix pass)

| Phase | First audit | Now |
|---|---|---|
| 1 Token budget | B− | **A−** (R2 is the leftover) |
| 2 TaskLedger | C+ | **B+** (R1 native ancestor, R4 demotion) |
| 3 Memory | C | **B+** (C1 wired; R5 pending wipe) |
| 4 Provider caps | C | **A−** (fallback only if session_start doesn’t bind) |
| 5 Child surface | B− | **A−** (ENV_TIPS name leak only) |

---

## Bottom line

The first audit’s C1–C6 are fixed in production code, not just in comments. The new `composition.ts` / C4 / C5 / H2 tests are the right shape and they pass.

Ship-quality remaining work is small and local:

1. **R2** — set `lastAnswer` on the continuation return (and persist chain token totals).
2. **R1** — native `beginRun` needs a task-shaped ancestor, plus one echo test through a real cell.
3. **R5 / R4 / R3** — consolidate splice, demotion→`runClaimedLeaf`, delegation `ENV_TIPS`.

Until R2, a budget-capped `rlm` run can look answer-less in the emitter for a tick (or permanently for anything that only listens to the engine’s own `emitAnswer`). Until R1, native ancestor-echo is mostly ceremonial.

The plan epilogue that says every audit row is done is **ahead of the code** on R1, R2, R4, R5, and the C1 test seam. Update that table when those land; don’t update it now.
