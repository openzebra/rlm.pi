# RLM v5 Port — Critical Code Audit

**Date:** 2026-04-11
**Auditor:** native RLM orchestrator (read-only review; no production code changed)
**Plan:** `RLM_V5_UPGRADE_PLAN.md`
**Source of truth:** `/Users/hicaru/projects/zebra/rlm_test` (`rlm_agent` 0.2.0 → 0.5.0)
**Target:** `pi-plugin/rlm/src/`
**Also opened:** `/Users/hicaru/projects/zebra/knowlange` (prompt-eval courseware — **not part of this port**; no findings)

---

## Verdict

**The port is real, substantial, and the new unit suites are green. It is not done, and it is not faithful on the paths that matter in production.**

All five plan phases exist as code (`TokenBudget`, `TaskLedger`, `MemoryStore`, `providerMaxConcurrent`, `childSurface`). Defaults are ON. `test/smoke.ts` includes the five new suites. I re-ran them:

| Suite | Result |
|---|---|
| `test/budget.ts` | ALL PASS |
| `test/ledger.ts` | ALL PASS |
| `test/memory.ts` | ALL PASS |
| `test/concurrency-provider.ts` | ALL PASS |
| `test/child-surface.ts` | ALL PASS |

Those suites construct engines and handlers **with the deps the production `rlm` tool forgets to pass**. The tests prove the libraries. They do not prove the product.

**Ship blocker:** the `rlm` tool / `RlmController.start()` path — the one the plan called "v5 MAIN parity" — never receives the session `MemoryStore` and never receives provider-capped gates. The 10 051 → 0 tok replay, `[memory]` injection, and the zai `> 4` cap do not fire on that path.

**Do not treat this as "v5 is in." Treat it as "v5 libraries landed; two composition roots were only half-wired."**

---

## What actually landed (verified)

| Phase | Plan capability | Code | Default | Wired into `repl()` | Wired into `rlm` tool |
|---|---|---|---|---|---|
| 1 | Token budget cascade | `core/budget.ts` + engine loop | `enableTokenBudget: true` | yes (via `createEngine`) | yes (same engine) |
| 2 | TaskLedger blackboard | `core/ledger.ts` + handlers | `enableLedger: true` | yes, **but `beginRun` never called** | yes, engine `beginRun`s |
| 3 | Durable L1/L2 memory | `core/memory.ts` | `enableMemory: true` | yes (`deps.memory`) | **NO — `start()` drops it** |
| 4 | Per-provider caps | `effectiveSubcallLimit` / `effectiveChildLimit` | unset (`undefined`) | yes, at `session_start` | **NO — engine builds uncapped private gates** |
| 5 | Child role separation | worker `--surface child` | `childSurface: "delegation"` | children of `rlm_query` yes | same (engine spawn) |

Hard project rules that hold: no file > 1 000 lines (largest new/touched: `scaffold.py` 606, `memory.ts` 506, `engine.ts` 474), zero `any`, zero `!`, `Object.freeze` on defaults, fail-soft I/O on memory/cache writers, `createSubcallHandlers` still the single subcall impl (DRY #1–#5 mostly).

Intentional plan deviations that match the plan's own epilogue: no SettingsList row for provider caps; `rlmBudget` kept at 8; models cache is offline-first (no OpenRouter fetch).

---

## Critical (will fire in production)

### C1. `RlmController.start()` drops memory and provider-capped gates

`index.ts` builds a session `MemoryStore` and, at `session_start`, builds gates with `effectiveSubcallLimit` / `effectiveChildLimit`. Those are handed to `createReplTool`. The headless / native-mode path does not get them.

```110:119:pi-plugin/rlm/src/mode/rlm-mode.ts
      const engine = createEngine({
        model: models.model,
        llmModel: models.llm,
        registry: ctx.modelRegistry,
        config: this.config,
        signal: abortController.signal,
        emitter: emitter ?? new RlmEmitter(),
        limits: limitsFromConfig(this.config),
      });
      return await engine({ rootPrompt: input.rootPrompt, context: contextValue, depth: 0 });
```

`this.memory` is on the controller and never passed. `gates` is omitted, so `createEngine` falls back to:

```164:165:pi-plugin/rlm/src/core/engine.ts
      gates: deps.gates
        ?? createSubcallGates(deps.config.maxConcurrentSubcalls, deps.config.maxConcurrentChildren),
```

and:

```128:130:pi-plugin/rlm/src/core/engine.ts
    const rootMemory =
      deps.memory !== undefined && deps.config.enableMemory ? deps.memory : undefined;
```

**Effect on the `rlm` tool and native RLM-mode runs:**

- L1 replay is dead (the 10 051 → 0 tok number cannot happen here).
- `[memory]` is never injected.
- Child `rlm_query` from this engine also sees `memory: undefined`, so child episodes are not recorded either.
- Provider caps are ignored. A zai smart/worker model can still exceed 4 concurrent requests — the exact failure Phase 4 exists to stop.

`repl()` is wired correctly. The two entry points disagree. This is how issue #4 happened last time (DRY #6: a second construction path that forgets to grow).

**Fix:** pass `memory: this.memory` and the session `gates` into `createEngine`. The gates currently live in a `session_start` closure in `index.ts`; they need to be reachable from the controller (or rebuilt the same way). Add a test that `RlmController.start` actually replays an episode and that its engine's leaf gate equals `effectiveSubcallLimit(...)`.

---

### C2. Every successful `rlm_query` emits two UI nodes

`childRun` emits a node for the ledger decision, and when the decision is `"run"` it **falls through** and emits a second node that is the one the engine actually reports against.

```146:188:pi-plugin/rlm/src/bridge/handlers/rlm-query.ts
    const decision = ledger.tryClaim(...);
    const subId = inv.emitter.emitSubcallCreated({
      label: decision.type === "run" ? "rlm_query" : `rlm_query (${decision.type})`,
      ...
    });
    if (decision.type === "echo") { ... return emptyResult(ECHO_STUB); }
    if (decision.type === "coalesce") { ... return emptyResult(String(twin)); }
  }

  const subId = inv.emitter.emitSubcallCreated({
    kind: "rlm",
    label: "rlm_query",
    ...
  });
```

Ledger is **on by default**. So the common path is the broken one.

AGENTS.md DRY #5 / the plan: *"`childRun` emits its own node for recursive ones (never wrap it, or the node is reported twice)."*

The first node is left `running` forever. The TUI tree will show a ghost sibling for every real child.

**Fix:** emit once. On `"run"`, keep that `subId` and do not emit again. Tests should assert `emitSubcallCreated` count === 1 for a single `rlm_query`.

---

### C3. Native `repl()` never `beginRun`s — ancestor-echo is dead on the primary UX path

```125:125:pi-plugin/rlm/src/core/engine.ts
    if (deps.config.enableLedger) runLedger.beginRun(input.rootPrompt);
```

```136:136:pi-plugin/rlm/src/tool/repl-tool.ts
  const sessionLedger = new TaskLedger();
```

`sessionLedger` is passed into handlers. Nothing ever calls `beginRun` / `endRun` on it.

`detectEcho` walks `this.stack`. Empty stack → no echo, ever, for a child that restates the user's prompt. Exact-hash and Jaccard coalesce still work (they look at `claims`, not `stack`). The plan's headline *"`dup_spawn` + ancestor-echo"* is only half-true in native mode.

A child engine *does* `beginRun(input.rootPrompt)` on the shared ledger, so a **grandchild** echoing *its parent* is detected. A **child** echoing the native user prompt is not.

**Fix:** `beginRun` the current user text (or the repl cell / turn prompt) around each native turn, `endRun` in `finally`. Mirror the engine. Add a native-path test, not just a `createEngine` test.

---

### C4. Continuation handoff drops all REPL state in production

`distillTrajectory` harvests state with:

```135:135:pi-plugin/rlm/src/core/budget.ts
const STATE_NEEDLE = "REPL stdout";
```

v5 does the same, **plus** `role == "tool"`. The plugin has no `tool` role.

Production history is built by `formatReplOutputs` → `appendUserMessage`. `formatReplOutputs` (`core/answer.ts`) never prefixes `"REPL stdout:"`. It emits raw stdout / `"(no stdout)"`.

`test/budget.ts` injects the needle by hand, so the unit test is green and the production path is empty. A hard-cap continuation therefore hands the next run:

- the original query (ok)
- last assistant prose (ok)
- **no REPL state** (the working set)
- a next-step guess from assistant text, or `DEFAULT_NEXT_STEP`

That is the v4 "finalize NOW" bug in a different costume: the cascade fires, the leaf starts blind.

**Fix (pick one):**

1. Prefix `formatReplOutputs` with `"REPL stdout:\n"` (matches v5 + the tests), or
2. Drop the needle and treat every non-system user message after turn 0 as state.

Also: findings are collected newest-first and joined in that order; v5 takes `findings[-6:]` chronologically. Reverse before join.

---

### C5. Child prompt still teaches `search` / `grep_context` / `outline`

Runtime is correct. Worker `_restore_scaffold` omits those names when `surface == "child"`. `test/child-surface.ts` proves it.

The system prompt is not:

```83:91:pi-plugin/rlm/src/prompts/system.ts
    if (opts.delegation ?? false) {
      parts.push(
        "",
        "**REPL API (ONLY these):** llm_query / ... / memory.* / list_claims. "
        "There is no search/grep_context/outline here — ...",
      );
    }
```

Then it **unconditionally** calls `replGlossary(...)`, which always appends `RETRIEVAL_GLOSSARY_LINES` and a worked example that starts with `hits = search(...)`. `RECURSION_CONTEXT_LINES` still says a child *"runs `search` / `grep_context` / `outline` / `map_files`"*.

A delegation child is told two opposite things. It will call `search`, get `NameError`, and burn turns. Phase 5 is half-done: the sandbox changed, the prompt doctrine did not.

`prompts/native.ts` also never mentions `memory.query` / `list_claims` (0 hits). Plan: native exposes `memory.query` instead of auto-injecting. The API exists; the model is not told.

**Fix:** `replGlossary` must take `delegation` and omit retrieval + `add_context` + the search example. Rewrite `RECURSION_CONTEXT_LINES` for the new doctrine ("child cannot search; send a sliced world"). Document `memory.*` / `list_claims` in the native prompt.

---

### C6. Phase 4 caps the wrong model for child engines

```223:226:pi-plugin/rlm/src/index.ts
      const gates = createSubcallGates(
        effectiveSubcallLimit(liveConfig, [model.provider, llmModel.provider]),
        effectiveChildLimit(liveConfig, llmModel.provider),
      );
```

Child engines run the **smart** model (`getModel()`), not the worker. Leaf completions run the worker (`getLlmModel()`).

- Smart = zai, worker = openai → child gate uses openai. **zai child engines uncapped.** This is the outage Phase 4 named.
- Smart = anthropic, worker = zai → leaf gate is `min(16, zai, anthropic)`, so anthropic leaves are also clamped to 4. Harmless but crude.

`effectiveSubcallLimit` folding *every* in-use provider into the *leaf* gate is the wrong shape. Leaves should cap against the worker provider only. Children should cap against the smart provider only.

Gates are also built once at `session_start`. `/rlm-config` changing `providerMaxConcurrent` later is a no-op until restart.

---

## High

### H1. Coalesce waiters can hang forever

`TaskLedger.waitFor` has no timeout. v5 `wait()` takes one and returns `"[ledger: timeout waiting for {tid}]"`.

If the runner is aborted, the sandbox dies during `DETACHED_SETTLE_MS`, or `fail()` is skipped, every twin parks forever. Native detached `spawn()` makes this reachable.

`fail()` marks `error` but does not wake *future* `waitFor` callers (only waiters registered at fail time). A late coalesce onto an already-errored key goes through `lookup` (skips error) → new `"run"`. That part is ok. A late `waitFor` on a still-pending dead claim is not.

### H2. L1 replay key for continuations / root persist is wrong

Replay is skipped when `input.budget !== undefined` (continuations don't short-circuit — good).

`persistRoot` uses `rootKey` derived from **this invocation's** `rootPrompt`. A continuation's prompt is the handoff, so it persists under a key the next user will never request. The original prompt is not updated with the continuation's answer.

After a budget-capped run, the next identical user prompt misses L1. The headline 0-token replay does not survive the feature that creates continuations.

Also `persistRoot` is skipped for `"(aborted)"` but **not** for `"(stopped: …)"` LimitError answers — those get recorded and will replay as if they were real.

### H3. `llm_batch` / `map_files` / `llm_query_chunked` bypass the ledger

Only single `llm_query` and `rlm_query` call `tryClaim`. A batch of identical prompts still pays N times. The blackboard is optional on the hottest fan-out path.

### H4. `Claim.status` is never `"running"`

`tryClaim` writes `"pending"`. `finish` / `fail` write `"done"` / `"error"`. Nothing writes `"running"`. v5 `begin_run` does. The union and `injectBlock`'s `pending | running` branch are dead weight. Not a functional break (inflight still lists `pending`), but the port claims v5 lifecycle and does not implement it.

### H5. `Claim.status` / `Claim.result` are mutable and not `readonly`

Project rule: *"`readonly` on ALL interface properties."* `Claim` is the one new interface that breaks it. Use a discriminated union (`PendingClaim | DoneClaim | ErrorClaim`) or keep the fields readonly and replace the object.

### H6. Root replay ignores path hashes

Root episodes record `paths: []`, so `pathHashes` is empty, so `hashesFresh` is vacuously true. Any identical prompt over *any* later tree replays the old answer. `contextSig` is in the key, which saves you when the packed snapshot changes, but:

- native cwd seed can produce a stable listing while file bodies change (sig hashes contents — good if the packed payload is the real files);
- if context is a path-only listing, or the same files are re-packed with identical content after a semantic-but-not-textual change you care about, you still replay.

More importantly: **root replay does not snapshot the files the answer depended on**, only the context blob present at start. v5 snapshots `paths` the run touched. The plugin's root path never fills `paths`.

### H7. `fileSha256` comment is a lie; no path jail

Comment: *"Streamed sha256 of one file (64KiB chunks)"*. Body: `readFileSync(path)` of the whole file. A large path in `rlm_query(..., paths=['huge.bin'])` can spike memory.

`join(this.root, rel)` is not resolved against root. `paths=['../.env']` hashes a file outside the workspace. Contents are not stored (only the digest), but it is still a traversal.

### H8. `maxTokens` still throws

`LimitGuard.observe` still throws `LimitError` when `config.maxTokens` is set. The budget cascade does not replace that path; it sits next to it. Default `maxTokens` is unset, so stock configs are fine. Anyone who sets `maxTokens` thinking it is the new budget gets the old mid-run abort with **no** continuation. The 1.2M-token runaway the plan named is fixed only if users leave `maxTokens` alone and trust `enableTokenBudget`.

### H9. Continuation result drops parent spend

```396:401:pi-plugin/rlm/src/core/engine.ts
              const inner = await run({ ...input, rootPrompt: continuationPrompt(...), budget: cont, ... });
              return { ...inner, iterations: inner.iterations + completedTurns };
```

Returned `inputTokens` / `outputTokens` / `costUsd` are the **leaf only**. UI and any parent `addRaw` see a cheap continuation, not the chain. `iterations` is folded; money is not.

The continuation also spreads original `input.context`, not `liveContext`. Sources added during the dying run are invisible to the leaf.

---

## Medium

### M1. `ModelContextRegistry.observe()` is dead in production

`limitFor` is used as a fallback when `model.contextWindow` is missing. `observe` is tested and never called from `engine.ts` / `index.ts`. The on-disk cache will stay empty unless a test writes it. Offline-first degrades to the static table + 32k, which is what the plan allowed — the cache half of the plan is unused.

`contextWindowOrFallback` also constructs a **new** registry per call and never shares it with memory.

### M2. `consolidate()` is fire-and-forget with a race

```168:168:pi-plugin/rlm/src/core/memory.ts
    if (this.pending.length >= this.evolveEvery) void this.consolidate();
```

Two overlapping `recordEpisode` bursts can run two consolidations on the same pending set. Notes duplicate; `pending` is cleared by whoever finishes last. Should be a single in-flight promise.

JSON extraction via `raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)` will happily parse the first array-looking substring in a prose refusal.

### M3. `memoryDir: null` does not disable memory

`defaults.ts` has `memoryDir: null`. `index.ts` does `dir: config.memoryDir ?? undefined`. `MemoryStore` then treats "no dir" as "use `<root>/.rlm/memory`". The constructor's `enabled && opts.dir !== null` never sees `null`. The only real off switch is `enableMemory: false`. The config field does not mean what it says.

### M4. Native and headless ledgers are different objects

A native `repl()` turn and a subsequent `rlm` tool call do not share claims. Coalesce / echo / `rlmBudget` reset at the boundary. Acceptable if documented; today it looks like one session blackboard.

### M5. Child `add_context` handler is still installed

`engine.ts` spreads `buildAddContextHandler` whenever `contextLoader` is on, including `depth > 0`. The worker will not bind the name on `surface=child`, so this is a dead handler, not a hole. Still contradicts Phase 5 and keeps a host path a confused child could theoretically hit if the scaffold check ever regresses.

### M6. Glossary / prompt drift beyond C5

- `RECURSION_CONTEXT_LINES` describes pre-v5 children.
- Orchestrator addendum still says "If free search/grep already pins a tiny fact" inside child prompts.
- `FINALIZE_PROMPT` asks for a fenced `repl` block *or* plain text; budget wrap-up asks for `answer["ready"] = True`. Three finalize dialects.

### M7. Settings validation asymmetry

`subSampling` object is not `Object.freeze`d; `rootSampling` is. `providerMaxConcurrent` is frozen. `budgetShare` rejects `> 1` but not `NaN` after `validateNumber` (depends on that helper). Minor.

### M8. `contextSig` / parsers use `as Record<string, unknown>`

Project rule prefers type guards. These are contained and fail-soft, not `any`, but they are the new code's sloppiest narrowing.

### M9. Tests do not cover the composition roots

Missing, and each would have caught a Critical:

| Missing test | Would have caught |
|---|---|
| `RlmController.start` passes `memory` + session `gates` | C1 |
| `emitSubcallCreated` count for one `rlm_query` | C2 |
| native `repl` ancestor-echo against the user prompt | C3 |
| `distillTrajectory(formatReplOutputs(...))` contains stdout | C4 |
| child system prompt must not contain `` `search` `` | C5 |
| `effectiveChildLimit` uses **smart** provider | C6 |
| `waitFor` timeout | H1 |
| continuation persist key === original root key | H2 |

`phase4.ts` is correctly pinned to `childSurface: "legacy"` (inheritance, not doctrine).

### M10. `.rlm/` gitignore is fine; nothing stops writing secrets into notes

Root `.gitignore` already has `.rlm/`. Good. `memory.add` / consolidation persist prompt+answer slices (200+400 / 200+600 chars) to disk. If a child answer contains a key, it lands in `notes.json`. Same as v5. Worth a one-line warning in the prompt, not a blocker.

---

## Low / fidelity notes (not blockers)

- `TokenBudget` dropped v5's `offset` field and instead uses a fresh instance + `observeTotal` absolute accounting. Semantically equivalent **because** each engine invocation has its own `LimitGuard`. Documented in the file header. Fine.
- `cap <= 0` cannot happen (`Math.max(1, …)`); `state()`'s `cap <= 0` branch is dead.
- `DEFAULT_NEXT_STEP` dropped "editing" — correct (children do not edit).
- Handoff template: plugin puts `[continuation n]` in `continuationPrompt`; v5 puts it inside `HANDOFF_TEMPLATE` with `n="?"` at distill time. Equivalent.
- `truncateMid` uses a fixed-length elision marker and `>> 1`; v5 mid-truncates the *whole* handoff. Plugin mid-truncates each section. Better, actually.
- `normalizePrompt` trailing-period handling matches v5 (`.replace(/^[ .\t]+|[ .\t]+$/g, "")`). Tests lock it. Good.
- Jaccard thresholds: plugin `NEAR=0.8`, `NEAR_SAME_PATHS=0.7`, `ECHO=0.8`. v5 `echo_jaccard=0.8`, `near_jaccard=0.7` used slightly differently (`find_near` 0.8 general / 0.7 same paths; echo also has a subset-paths clause at 0.7). Plugin is stricter on echo (no subset-path shortcut). Acceptable, not identical.
- v5 ledger is mutex-locked (`threading.Lock`). Plugin is single-threaded JS; `tryClaim` is sync. OK.
- `map_files` remains on the child surface. That is delegation over an already-sliced `context`, not repo retrieval. Reasonable; plan's "ONLY these" list should include it (the child prompt already does).
- `knowlange` is unrelated courseware. Ignore it for this port.

---

## Phase-by-phase score

### Phase 1 — Token budget — **B−**

Library is close. `resolveBudget` matches v5 (`share × ctx`, clamp `budgetTaskCap`, floor, min 1). Soft/hard/continuation math matches. Engine integrates it and does **not** throw on hard (good). Tests cover the scripted cascade.

Pulled down by C4 (handoff is empty of REPL state), H8 (`maxTokens` still a footgun), H9 (reported tokens are the leaf), and the fact that `maxTokens` / budget coexistence is undocumented.

### Phase 2 — TaskLedger — **C+**

Coalesce + Jaccard + `rlmBudget` demotion work, and the engine-level tests prove it **when `beginRun` is called**. Native path forgets `beginRun` (C3). Double-emit (C2). No wait timeout (H1). Batches skip the ledger (H3). `running` state unused (H4). `readonly` broken (H5).

This is the phase most likely to look "done" in a demo and fail in a long native session.

### Phase 3 — Memory — **C**

Store implementation is a competent, fail-soft port (jsonl episodes, notes.json, BM25-ish query, hash-drift invalidation, `serviceOp` as the one sandbox seam). Tests cover L1/L2 in isolation and a sandbox `memory.query` probe.

Pulled down hard by C1 (headless/`rlm` tool never receives the store), H2 (continuation / stopped-answer keys), H6 (root episodes have no path hashes), H7 (fake streaming + traversal), M2 (consolidate race), M3 (`memoryDir: null` is a no-op), and the native prompt silence.

Until C1 is fixed, Phase 3 is a library, not a product feature.

### Phase 4 — Provider caps — **C**

Helpers and unit tests are correct *as specified*. Composition applies them only to `repl()`, with the **worker** provider on the child gate (C6) and a one-shot build at session start (M7-adjacent). Status line surfaces caps. Config-panel row dropped as documented.

A user who puts `{ "zai": 4 }` in `rlm.json` and then uses zai as the **smart** model is not protected.

### Phase 5 — Child surface — **B−**

Best-executed phase at the **runtime** layer: worker flag, engine spawn, legacy rollback, tests at worker *and* engine level, `phase4.ts` pinned to `legacy`. Retrieval + `add_context` really are absent in a child sandbox.

Pulled down by C5 (prompt still teaches search) and M5 (host still registers `add_context` for children). Doctrine is "prompt + runtime + tests." Only runtime + tests landed.

---

## DRY / type-safety / architecture checklist

| Rule | Status |
|---|---|
| Single `complete1` / `createSubcallHandlers` | holds |
| Single `childRun` | holds |
| Single `displayModel` | mostly; `llm-query.ts` has its own |
| `emitting()` for leaves; `childRun` emits its own node | **broken** (C2 emits twice) |
| `getChildContext` is the one inheritance seam | holds |
| `RlmInput.ledger` is the one child-ledger seam | holds **as a field**; native forgets `beginRun` |
| Zero `any` / zero `!` | holds in the new files I read |
| `readonly` on every interface prop | **broken** on `Claim` |
| `Object.freeze` on constants | holds on defaults / templates |
| `Result<T,E>` for fallible I/O | memory/cache use `boolean` fail-soft (allowed) |
| Pre-allocated arrays | used in `listClaims` / `serviceOp`; `distillTrajectory` still `.push`es (tiny, fine) |
| No file > 1 000 lines | holds |
| Engine still no disk I/O of its own | holds (memory I/O is in `MemoryStore`) |

The architectural smell is the same one that caused issue #4: **two composition roots** (`createReplTool` vs `RlmController.start`) that must be kept in lockstep by hand. v5 features were added to one and not the other.

---

## Recommended fix order

Do these before calling the port shipped. None of them need new scope.

1. **C1** — thread `memory` + session `gates` through `RlmController.start`. One test on the controller, not on `createEngine`.
2. **C2** — one `emitSubcallCreated` per `childRun`. One assertion on emit count.
3. **C3** — `sessionLedger.beginRun` / `endRun` around each native turn.
4. **C4** — make `formatReplOutputs` (or `distillTrajectory`) agree. Test through the real formatter.
5. **C5** — `replGlossary(..., { delegation })`. Grep the child prompt for `` `search(` `` in `test/child-surface.ts`.
6. **C6** — `effectiveChildLimit(cfg, smartModel.provider)`; leaf limit against worker only. Rebuild gates when config changes.
7. **H1 / H2 / H8** — waiter timeout; persist continuations under the *original* root key (or skip persist on non-clean answers); document that `maxTokens` is a hard abort and budget is the wrap path.

Everything else in Medium/Low can follow.

---

## What I would *not* reopen

- Replacing `offset` with a fresh `TokenBudget` + `observeTotal`. It works.
- Dropping the SettingsList row for provider caps. Right call.
- Keeping `childSurface: "legacy"` as a rollback. It works; `phase4.ts` uses it correctly.
- Offline-only model cache. Fine.
- Leaving `map_files` on the child surface. That is delegation, not retrieval.
- The Python split (`worker.py` protocol / `scaffold.py` API). Cleaner than v5's single worker, and under the 1 000-line cap.

---

## Bottom line

The plan's five tables are in the tree. The tests that were written pass. A careful reading of the composition roots shows that **the `rlm` tool does not run v5 memory or v5 provider caps**, **native echo detection does not run**, **every real `rlm_query` is drawn twice**, **continuations forget the REPL**, and **delegation children are still taught to `search`**.

That is not a failed port. It is an unfinished one, with the unfinished work sitting exactly where the last serious bug (issue #4, child context inheritance) sat: the second construction path.

Fix C1–C6 before advertising v5.
