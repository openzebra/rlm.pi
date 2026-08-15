# RLM v5 → pi-plugin Upgrade Plan

**Source of truth:** `/Users/hicaru/projects/zebra/rlm_test` (`rlm-agent` engine, changelog 0.2.0 → 0.5.0 —
the final codebase state is what we call **v5**).
**Target:** `pi-plugin/rlm/src/` (81 files, 10,726 lines today; largest file `sandbox/py/worker.py` at 949 lines).
**Method used for this plan:** 7 parallel deep-study agents over both codebases + verbatim source extraction.

---

## 0. Executive summary

The test engine proved five things with live numbers. We port all five into the plugin, one shippable
phase at a time, without breaking anything that works today:

| # | v5 capability | Headline evidence | Plugin today | Phase |
|---|--------------|-------------------|--------------|-------|
| 1 | **Token budget cascade** replaces timeouts as the primary run control | coding task **97,469 → 2,004 tok**, correct; s_niah under a 1.6k cap *cheaper than uncapped*; continuation chains proven live (never > 2) | `maxTokens` exists but is **undefined by default** and, when set, **throws** mid-run (no soft wrap, no continuation). The 1.2M-token runaway is exactly this gap. | **1** |
| 2 | **TaskLedger blackboard** — every agent sees inflight/done claims; duplicate work is coalesced or rejected | `dup_spawn subcalls_rlm=1` offline gate; ancestor-echo + Jaccard near-dup coalescing | Nothing. `rlm_query` twins are possible. | **2** |
| 3 | **Durable memory** under `<root>/.rlm/` — L1 episodes (0-token replay), L2 BM25 notes | codeqa s2 replay: **10,051 → 0 tok (−100%)**, `memory_hits=1` | Nothing. No `.rlm` dir, no replay, no notes. | **3** |
| 4 | **Concurrency is a config surface** (`max_concurrent_subcalls=4` wired into the task registry) | single knob, thread pool in `BackgroundTaskRegistry` | Already *better*: `maxConcurrentSubcalls=16` + `maxConcurrentChildren=6` + per-depth `DepthGates`. **Missing: per-provider caps** (zai breaks > 4 concurrent). | **4** |
| 5 | **Role separation** — llm leaves read-only; rlm children delegate (no read/grep); edit lives only at the root | enforced by closed REPL API lists in `rlm_worker.py` | Root REPL is correct; **child engines get the full surface** (search/grep/outline) — looser than v5 doctrine. | **5** |

Hard rules honored throughout (per project AGENTS.md + your global rules):
DRY (zero duplicated logic), `strict` TS, zero `any` (always `unknown`), zero `!` non-null assertions,
`readonly` on all interface props, `Object.freeze()` on constants, `Result<T, E>` for fallible ops,
fail-soft I/O (writers return `boolean`, never throw), pre-allocated arrays, `.join('')` for big strings,
**no file > 1,000 lines**, and nothing currently working gets removed.

---

## 1. Version archaeology — what each version actually changed

From `CHANGELOG.md` + `result_mem_ledger_v*.md` (verified):

| Version | Name | Added | Live result |
|---------|------|-------|-------------|
| 0.2.0 (v1) | Dual-mode runtime | classic engine (paper Alg. 1), orchestrator, `search`/`grep_context`/`outline`, benches | baseline: coding 97,469 tok; get_json 32,583 tok |
| 0.3.0 (v2) | TaskLedger + memory | `ledger.py` (task_key, coalesce, echo, near-dup, `rlm_budget=8` demotion, `[ledger]` inject), `memory/store.py` (L1/L2, `<cwd>/.rlm/memory/`), empty-inject → `""` (v1 burned ~150+90 chars/turn), `skip_noted` pack pruning | codeqa s2 replay 0 tok; ledger+mem coding **hit** vs baseline **miss** |
| 0.4.0 (v3) | Cost governor | `governor.py`: G1 `compress_history` (elide old tool payloads, **head+tail** — head-only bug caused 3→8 turns), G2 budget soft/hard, G3 `verify_fn`, G4 anti-recursion note; write/edit contract prompt | coding **97,469 → 2,923 tok (−97%)**, 4 turns |
| 0.5.0 (v4) | Token budget cascade | `models.py` `ModelContextRegistry` (OpenRouter ctx, disk cache, 32k fallback), `budget.py` `TokenBudget` (share×ctx, soft 80%, offset-anchored), **continuation leaf** (distill → fresh run, chain ≤ 2), `clamp_watchdog` (wall-clock demoted to 900s hang backstop) | get_json correct under forced 12k cap; s_niah 1.6k cap → 3,987 tok; coding **2,004 tok** (best ever); fixed the "finalize NOW produced a wrong answer at 9,654/12,000" flaw |
| **current (v5)** | **Final state** | all of the above, converged: budget governs, ledger shares state, memory persists, registry caps parallelism at `max_workers=4`, closed child API lists | 5/5 live correct, 17/17 offline gates, 81 tests |

**The 1.2M-token bug you hit**: the plugin has *no default per-run token cap at all* (`maxTokens` is
`undefined` in `DEFAULT_CONFIG`) and `compactionThresholdPct: 0.65` only estimates history size —
nothing stops a 30-iteration loop whose *cumulative* spend exceeds the model's 1M window. v5's fix is
not "a bigger timeout", it is: **cap = contextWindow × 0.25, soft wrap-up at 80%, hard → distill +
continuation, wall-clock demoted to a hang backstop.**

---

## 2. v5 final architecture (as verified in source)

### 2.1 Capability matrix — who may do what

| Role | REPL | edit/write files | read context / grep | sub-LLM calls |
|------|------|------------------|---------------------|----------------|
| **llm leaf** (`spawn_llm`) | no | no | **no** — text-in only | no |
| **rlm child** (`spawn_rlm`) | private, **closed list** | **no** | **no** (task arrives as text; `paths` narrows inherited context) | yes (`llm_query`/`llm_batch`; rlm recursion per depth) |
| **classic root** | full | **yes — only here** (`edit_fn`/`write_fn` handlers) | yes | yes |
| **MAIN orchestrator** | no | no | no | spawns everything |

### 2.2 The injection block (blackboard + memory + runtime), verbatim wiring from `classic.py`

```python
system = system_prompt if system_prompt else (RLM_WORKER_PROMPT if child else CLASSIC_ROOT_PROMPT)
extra = ""
if ledger is not None:
    block = ledger.inject_block()          # "" when nothing claimed
    if block: extra += "\n" + block
if memory is not None and memory.enabled:
    mblock = memory.inject_block(query)    # "" when no notes
    if mblock:
        extra += "\n" + mblock
        usage.add_memory_notes(memory.notes_injected)
extra += f"\n[runtime] you are depth={depth}; rlm_query only for a disjoint path set."
```

Rules baked in from real bugs: **empty store injects nothing** (v1 burned ~150 + ~90 chars per turn
for zero value), blocks are appended to the *user content* (both MAIN and workers), and the ledger
block carries the doctrine line `rlm_query only for a disjoint goal. ancestor echo is rejected.`

### 2.3 Budget state machine (per run, offset-anchored for chains)

```
spent = (inputTokens + outputTokens) - budget.offset
spent >= cap            → "hard"  → distill_trajectory → continuation run (offset = spent, same counters), chain ≤ 2
spent >= floor(cap*0.8) → "soft"  → ONE wrap-up turn: WRAP_UP_BUDGET prepended; finalize if answerable else findings dump
else                    → ""      → run normally
```

`WRAP_UP_BUDGET` (verbatim):

```
[budget] ~80% of your token cap — ONE turn left. If the task is answerable NOW, finalize
(answer['ready']=True). Otherwise print a compact findings dump: what is confirmed, current
file/line or search position, and the exact next step — a fresh continuation picks it up.
Do not start new exploration.
```

### 2.4 Key v5 constants (all verified in `config.py` / `budget.py` / `models.py`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `budget_share` | `0.25` | cap = 25% of model context window |
| `budget_soft_frac` | `0.8` | soft wrap-up at 80% of cap |
| `budget_task_cap` | `400_000` | absolute ceiling for any single run |
| `budget_max_continuations` | `2` | MAS²-style rectifier, chain-capped (root + 2 leaves) |
| `budget_handoff_chars` | `4_000` | distill handoff budget |
| `watchdog_s` | `900` | hang backstop only (content control is the budget's job) |
| `rlm_budget` | `8` | after 8 real rlm spawns, extra `rlm_query` demotes to `llm_query` |
| `max_concurrent_subcalls` | `4` | thread-pool width in `BackgroundTaskRegistry` |
| `inject_note_tokens` | `2_000` | char budget for `[memory]` = tokens × 4 |
| `evolve_every` | `8` | consolidate pending episodes into notes every 8 episodes |
| `episode_cap` | `4_000` | episodes.jsonl rewrite-trim threshold |
| unknown model ctx | `32_000` | conservative offline fallback |
| models cache | `.rlm/models_cache.json`, TTL 86,400s | context lengths from OpenRouter `/api/v1/models` |

---

## 3. Gap analysis — plugin today vs v5

| Area | Plugin today (verified) | v5 | Action |
|------|------------------------|-----|--------|
| Run-length control | `maxIterations: 30` loop + `execTimeoutS: 120` per repl block + `requestTimeoutMs` watchdog + optional `maxTokens` that **throws** `LimitError` | model-aware budget, soft/hard/continuation; wall-clock = hang backstop only | **Phase 1** |
| History compaction | `compactHistory` **replaces whole history** with `[system, summary, "continue"]` at 65% of window | G1 elision of old tool payloads keeping head+tail *first*, summarize only after | **Phase 1b** |
| Model context awareness | `mode/llm-model.ts:34` already exposes `contextWindow`; `estimateTokens` = chars/4 | registry + disk cache + fallback table | reuse `contextWindow`; add only fallback + cache (Phase 1) |
| Duplicate work | none — `rlm_query` twins each run a full engine | exact-hash coalesce, ancestor-echo reject, Jaccard ≥ 0.8 / ≥ 0.7+same-paths near-dup, `rlmBudget` demotion | **Phase 2** |
| Global state visibility | none | `[ledger]` block + `list_claims()` | **Phase 2** |
| Durable artifacts | none (engine performs no disk I/O — by design, keep) | `.rlm/memory/{episodes.jsonl, notes.json}`, sha256 invalidation, BM25 notes, consolidate | **Phase 3** (host-side TS store; sandbox sees it via interrupts — the `add_context` pattern) |
| 0-token replay | none | replay gate before read-only runs; persist child results | **Phase 3** |
| Concurrency | `SubcallGates` (leaf `Semaphore`) + per-depth `DepthGates` — solid, defaults 16/6 | single `max_workers=4` | keep ours; add **per-provider caps** (Phase 4) |
| Child tool surface | child engines get **full** REPL (search/grep/outline) | children = delegation + memory/ledger only | **Phase 5**, config-gated |
| llm leaf purity | already correct (no fs, no context) | same | none |

---

## 4. Phase 0 — Hygiene & preparation (no behavior change)

Goal: make room inside the 1k-line rule and freeze a green baseline before touching behavior.

1. **Split `sandbox/py/worker.py` (949 lines).** Phase 2 + 3 add two scaffolds to it; it will breach 1k.
   Extract the REPL-scaffold installers (`_llm_query` … `add_context` wrappers bound in
   `_restore_scaffold`) into a sibling `scaffold.py` that `worker.py` imports (siblings resolve via
   `sys.path[0]` — same mechanism as `guards.py`/`retrieval.py`/`tasks.py`, zero packaging).
   Target: `worker.py` ≤ ~650, `scaffold.py` ≤ ~350. Pure move, no logic change.
2. **Dead-code sweep.** `tsc` already runs with `noUnusedLocals`; additionally grep for exported
   symbols with zero importers (`grep -rn "export const X"` vs `import … X`). Candidates found during
   this audit: **none confirmed** — do not delete anything without this check passing. Old artifacts
   on disk (if any `*.bak`, `*.old`, commented-out blocks) get removed in this pass.
3. **`.gitignore` += `.rlm/`** (Phase 3 creates it; ignore it from day one).
4. **Baseline:** `bun test` green, recorded in `answers["baseline"]` of this plan's PR description.

Exit criteria: all tests green, `wc -l` shows every file < 1,000, no behavior diff.

---

## 5. Phase 1 — Token budget cascade (the 1.2M-token fix)

### 5.1 New file `core/budget.ts` (~230 lines)

```ts
/** v5 port: per-run cumulative token budget. Cap = share × model context window.
 *  `offset` anchors chained continuations so a chain shares one logical budget. */
export interface TokenBudgetOptions {
  readonly softFrac?: number;
  readonly continuations?: number;
  readonly maxContinuations?: number;
  readonly offset?: number;
}

export type BudgetState = "" | "soft" | "hard";

export class TokenBudget {
  readonly cap: number;
  readonly softFrac: number;
  readonly continuations: number;
  readonly maxContinuations: number;
  readonly offset: number;

  constructor(cap: number, opts: TokenBudgetOptions = {}) {
    this.cap = Math.max(1, Math.floor(cap));
    this.softFrac = opts.softFrac ?? 0.8;
    this.continuations = opts.continuations ?? 0;
    this.maxContinuations = opts.maxContinuations ?? 2;
    this.offset = opts.offset ?? 0;
  }

  get soft(): number { return Math.floor(this.cap * this.softFrac); }
  get hard(): number { return this.cap; }

  state(inputTokens: number, outputTokens: number): BudgetState {
    if (this.cap <= 0) return "";
    const spent = Math.max(inputTokens + outputTokens - this.offset, 0);
    if (spent >= this.hard) return "hard";
    if (spent >= this.soft) return "soft";
    return "";
  }

  canContinue(): boolean { return this.continuations < this.maxContinuations; }

  nextContinuation(spent: number): TokenBudget {
    return new TokenBudget(this.cap, {
      softFrac: this.softFrac,
      continuations: this.continuations + 1,
      maxContinuations: this.maxContinuations,
      offset: Math.max(spent, 0),
    });
  }
}

export const WRAP_UP_BUDGET: string = Object.freeze(
  "[budget] ~80% of your token cap — ONE turn left. If the task is answerable NOW, finalize " +
    "(set answer['ready']=True). Otherwise print a compact findings dump: what is confirmed, " +
    "current file/line or search position, and the exact next step — a fresh continuation picks " +
    "it up. Do not start new exploration.",
) as string;

export const DEFAULT_NEXT_STEP =
  "continue the probing that was in flight, then finalize" as const;
```

`distillTrajectory` — deterministic handoff (no LLM call), ported field-for-field:

```ts
/** Deterministic trajectory → handoff (v5 `distill_trajectory`).
 *  query ≤ 800 chars; findings = last ≤ 6 assistant texts (> 20 chars);
 *  state = last ≤ 8 tool/user outputs mentioning REPL stdout; next = last finding
 *  containing a next-step verb, else DEFAULT_NEXT_STEP. Elision marker keeps size honest. */
export function distillTrajectory(
  messages: readonly ChatMessage[],   // pi-ai message shape
  query: string,
  handoffChars = 4_000,
): string {
  const parts: string[] = []; // .join('') — no += in loops
  // … slicing logic mirroring v5 (see budget.py L120–170) …
  return truncateMid(parts.join(""), handoffChars);
}
```

### 5.2 New file `core/model-registry.ts` (~120 lines)

**DRY decision:** the plugin already knows context windows — `mode/llm-model.ts:34` exposes
`contextWindow` from model metadata. The registry only adds what's missing: a conservative fallback
for unknown models and an optional disk cache.

```ts
const FALLBACK_CONTEXT: Readonly<Record<string, number>> = Object.freeze({
  "openai/gpt-5": 400_000,
  "openai/gpt-5-mini": 400_000,
  "anthropic/claude-sonnet-4.5": 200_000,
  "google/gemini-2.5-pro": 1_000_000,
  "qwen/qwen3-coder": 262_000,
  "deepseek/deepseek-chat": 128_000,
});
const UNKNOWN_CONTEXT = 32_000;
const CACHE_TTL_MS = 86_400_000;

/** Resolves a model's context window: metadata → .rlm/models_cache.json → fallback table → 32k. */
export class ModelContextRegistry {
  constructor(private readonly cachePath: string) {}   // <root>/.rlm/models_cache.json

  limitFor(modelId: string): number {
    return this.cached(modelId)
      ?? FALLBACK_CONTEXT[modelId]
      ?? UNKNOWN_CONTEXT;
  }
  // disk cache: fail-soft (read errors → miss, write errors → false + warn) per project rules
}
```

### 5.3 `resolveBudget` (in `core/budget.ts`)

```ts
export function resolveBudget(
  contextWindow: number | undefined,     // from llm-model.ts (existing, DRY)
  config: RlmConfig,
): TokenBudget {
  const ctx = contextWindow && contextWindow > 0 ? contextWindow : UNKNOWN_CONTEXT;
  const shareCap = Math.floor(ctx * config.budgetShare);
  const cap = config.budgetTaskCap > 0 ? Math.min(shareCap, config.budgetTaskCap) : shareCap;
  return new TokenBudget(cap, {
    softFrac: config.budgetSoftFrac,
    maxContinuations: config.budgetMaxContinuations,
  });
}
```

### 5.4 Engine wiring (`core/engine.ts`, ~+55 lines at the existing loop)

Today (`engine.ts:218`): `for (let i = 0; i < deps.config.maxIterations; i++) { limits.checkTimeout(); … }`
and usage already flows through `limits.addRaw(costUsd, inputTokens, outputTokens)` (`engine.ts:97`).

Insert after each turn's usage accounting:

```ts
// ── v5 budget cascade ─────────────────────────────────────────────
const u = limits.usage();                       // { inputTokens, outputTokens } (limits.ts:91)
const state = budget.state(u.inputTokens, u.outputTokens);
if (state === "soft" && !softFired) {
  softFired = true;
  trace.push({ turn: i, event: "budget_soft" });
  // prepend WRAP_UP_BUDGET to the next user turn (continuation-aware: if the task
  // is answerable the model finalizes; the findings dump it prints instead is
  // exactly what distillTrajectory consumes if we then hit hard)
}
if (state === "hard") {
  trace.push({ turn: i, event: "budget_hard_stop" });
  if (budget.canContinue() && config.enableTokenBudget) {
    const handoff = distillTrajectory(history, input.rootPrompt, config.budgetHandoffChars);
    const cont = budget.nextContinuation(u.inputTokens + u.outputTokens);
    trace.push({ turn: i, event: "budget_continuation", n: cont.continuations });
    return runRlm({
      ...input,
      rootPrompt: `[continuation ${cont.continuations}]\n${handoff}`,
      budget: cont,                              // same LimitGuard → counters keep accumulating
    });
  }
  break; // chain cap reached → finalize with what we have (no throw!)
}
```

Add `readonly budget?: TokenBudget` to `RlmInput` (optional, backwards-compatible; set only by the
engine itself for continuations). **Semantics change vs today:** hitting a budget never `throw`s —
the v4 "Run 1 flaw" (soft note produced a wrong answer and continuation never fired) is exactly why
the hard branch *distills and continues* instead of aborting. Keep `maxTokens` as an optional
absolute tree-cap backstop (unchanged, default `undefined` — the budget now governs by default).

### 5.5 Wall-clock demoted to hang backstop (config docs only — no code change)

`execTimeoutS` (per repl block) and `requestTimeoutMs` (parent watchdog) already protect against
*hangs*; that is precisely v5's `clamp_watchdog` doctrine. **Do not remove them** — they guard the
Pi UI. Document in `RlmConfig` comments: "content limits are the budget's job; these are hang
backstops." No new `watchdogS` field needed (v5's clamp exists because *the model* could supply
timeouts; our timeouts are host-owned already).

### 5.6 Phase 1b — G1 elision compaction (`core/compaction.ts`, ~+60 lines)

Before the existing whole-history `compactHistory`, insert v5's G1 (proven −97% on coding):

```ts
/** v5 G1: elide old tool/repl payload bodies, keep head + tail intact.
 *  Runs BEFORE summarize-and-replace; often avoids the summary entirely. */
export function elideOldToolPayloads(
  history: readonly ChatMessage[],
  keepTurns = 2,
  toolChars = 1_500,
): ChatMessage[] {
  // oldest messages beyond the last `keepTurns` turns: truncate tool outputs to
  // `${toolChars} chars + "\n…[elided v5-G1]…"`; never touch system or the last keepTurns turns.
}
```

Head+tail is load-bearing: v3 initially shipped head-only elision and turns *grew* 3 → 8 (documented
bug) — the tail carries the working set.

### 5.7 Config additions (`core/types.ts` + `config/defaults.ts` + `config/settings.ts`)

```ts
// core/types.ts — RlmConfig additions (all readonly)
/** v5 token budget: cap = budgetShare × contextWindow, clamped by budgetTaskCap. */
readonly enableTokenBudget: boolean;
readonly budgetShare: number;          // 0.25
readonly budgetSoftFrac: number;       // 0.8
readonly budgetTaskCap: number;        // 400_000
readonly budgetMaxContinuations: number; // 2
readonly budgetHandoffChars: number;   // 4_000
```

```ts
// config/defaults.ts — frozen additions
enableTokenBudget: true,
budgetShare: 0.25,
budgetSoftFrac: 0.8,
budgetTaskCap: 400_000,
budgetMaxContinuations: 2,
budgetHandoffChars: 4_000,
```

Validation in `settings.ts` with the existing helpers: `validateBoolean(cfg.enableTokenBudget)`,
`validateNumber(cfg.budgetShare, 0.01)`, `validateNumber(cfg.budgetSoftFrac, 0.5)`,
`validateNumber(cfg.budgetTaskCap, 1_000)`, `validateNumber(cfg.budgetMaxContinuations, 0)`,
`validateNumber(cfg.budgetHandoffChars, 500)`.

### 5.8 Tests (`test/budget.ts`, registered in `test/smoke.ts`)

Port v5's `tests/test_budget.py` (8 cases) + continuation gates from `test_governor.py`:
cap math (1M → 250k/200k; 32k → 8k/6.4k); `budgetTaskCap` clips; offset anchoring; chain ≤ 2;
handoff elision marker; **regression: soft note must not finalize a wrong answer under the cap**
(the v4 Run-1 flaw) — assert the hard branch distills instead.

---

## 6. Phase 2 — TaskLedger blackboard (global state)

### 6.1 New file `core/ledger.ts` (~260 lines) — ported verbatim-semantics

```ts
const NOISE = /\b(no edits?|do not edit|analysis[- ]only|do not change)\.?/gi;
const TOK = /[a-z0-9_]{2,}/g;

export function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(NOISE, " ")
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
export const tokenSet = (text: string): ReadonlySet<string> =>
  new Set(text.toLowerCase().match(TOK) ?? []);

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;                                  // no set spreads (allocation discipline)
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const pathSig = (paths: readonly string[]): string =>
  [...new Set(paths.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "")))].sort().join(",");

/** Fingerprint of the packed context so identical questions on different haystacks don't collide. */
export function contextSig(context: unknown): string {
  /* sha256 over (path, content) pairs — mirrors v5 context_sig; 16 hex chars */
}

export function taskKey(
  kind: "llm" | "rlm",
  prompt: string,
  paths: readonly string[],
  model: string,
  ctx: string,
): string {
  const raw = `${kind}|${model}|${pathSig(paths)}|${normalizePrompt(prompt)}|${ctx}`;
  return sha256Hex(raw).slice(0, 24);
}
```

```ts
export type ClaimStatus = "pending" | "running" | "done" | "error" | "echo";

export interface Claim {
  readonly key: string;
  readonly tid: string;
  readonly kind: "llm" | "rlm";
  readonly prompt: string;
  readonly paths: readonly string[];
  status: ClaimStatus;
  result: string | null;
  depth: number;
}

/** Session-wide (per root run) blackboard. One instance per run, threaded through
 *  SubcallHandlerDeps — the same seam as getChildContext (DRY rule 6). */
export class TaskLedger {
  private readonly claims = new Map<string, Claim>();
  private readonly stack: readonly string[] = [];
  private readonly hits: Readonly<Record<string, number>> = { exact: 0, echo: 0, near: 0 };

  /** Try to claim; returns { ok:true, claim } for the runner, or { ok:false, reason, existing }
   *  for a coalescing waiter / echo stub (Result<T,E> — no exceptions). */
  tryClaim(req: ClaimRequest): Result<Claim, LedgerReject> { /* … */ }

  detectEcho(prompt: string): boolean { /* normalized prompt ∈ ancestor stack */ }
  findNear(prompt: string, paths: readonly string[]): Claim | undefined {
    /* jaccard ≥ 0.8, or ≥ 0.7 ∧ same pathSig */
  }
  finish(key: string, result: string): void { /* … */ }

  /** v5 verbatim shape — "" when nothing claimed and stack ≤ 1. */
  injectBlock(): string {
    /* "[ledger]\n  depth_stack=N inflight=X done=Y\n  rlm_query only for a disjoint goal.
        ancestor echo is rejected.\n  inflight:\n  …(≤8)\n  done:\n  …(≤6)" */
  }
}
```

### 6.2 Wiring — one construction path (DRY rules 2 & 6)

`createSubcallHandlers` gains `readonly ledger?: TaskLedger` on `SubcallHandlerDeps`. `childRun`
(bridge/handlers) is the only place a child `RlmInput` is built — it passes the ledger down; the
engine exposes it on its `Invocation` exactly like `emitter`/`limits` today. The repl()-tool's
session-scoped path reuses the same `resolve()` seam — **no second construction path.**

Coalescing lives where tasks are already registered: `bridge/handlers/task-registry.ts` (202 lines
today). On `spawn`: `taskKey` → `tryClaim`:
- `ok:true` → run as today, `ledger.finish(key, result)` on settle;
- echo/near-dup/exact-hit → return the existing pending `Task` (many `await_task`s, one runner) or
  the stored result — **no new runner spawned**.

`rlmBudget` demotion (v5 `_spawn_single`, verified): in the single-spawn path only (batch is exempt),

```ts
if (kind === "rlm" && usage.subcallsRlm >= config.rlmBudget && llmRunner) {
  runFn = llmRunner; kind = "llm";   // demote, don't refuse
}
```

### 6.3 Injection + REPL surface

- `[ledger]` block: engine appends to user content exactly as v5 (§2.2) — gate: block ≠ "".
- `list_claims()` REPL function → new interrupt `ledger.claims` (protocol.ts) → host returns a
  compact claims table. Checklist per AGENTS.md "Adding a New Bridge Handler" (protocol →
  SubLlmHandlers → REJECT default → worker handler → RESERVED + `_restore_scaffold`).
- Prompt doctrine lines added to `prompts/glossary.ts` (shared → system + native):
  `"Never rlm_query a task already on [ledger] (inflight or done) — await it or reuse the result."`

### 6.4 Config + tests

`enableLedger: boolean (true)`, `rlmBudget: number (8)` — same validate wiring as Phase 1.
`test/ledger.ts`: exact coalesce (two identical `rlm_query` → 1 subcall), ancestor echo → stub,
near-dup ≥ 0.8 / 0.7+paths, demotion at 8, empty-inject `""`.

---

## 7. Phase 3 — Durable memory under `<root>/.rlm/`

### 7.1 Design decision (DRY + plugin architecture)

v5 implements the store in Python. **We implement it once, host-side, in TS** (`core/memory.ts`),
and the sandbox reaches it through interrupts — the exact pattern `add_context` already uses. This
keeps ONE implementation (no TS parser duplicating the Python query logic for the replay gate) and
honors "the engine performs no disk I/O": the *host* writes `.rlm/`, the sandbox only asks.

Layout (identical to v5):

```
<root>/.rlm/
├── models_cache.json        # Phase 1 registry cache (TTL 24h)
└── memory/
    ├── episodes.jsonl       # L1 — append-only, rewrite-trim at 4,000
    └── notes.json           # L2 — single JSON object, written wholesale
```

### 7.2 `core/memory.ts` (~380 lines)

Schemas (verbatim v5 fields, all `readonly`, frozen defaults):

```ts
export interface Episode {
  readonly key: string;            // taskKey("rlm", prompt, paths, model)
  readonly kind: "rlm" | "root";
  readonly model: string;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly pathHashes: Readonly<Record<string, string>>;  // rel path → sha256
  readonly result: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly ts: number;
}

export interface Note {
  readonly id: string;             // sha256(content|paths)[:16]
  readonly content: string;
  readonly timestamp: number;
  readonly keywords: readonly string[];   // auto: first ≤ 12 tokens
  readonly tags: readonly string[];
  readonly context: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly links: readonly string[];      // top-4 BM25 neighbors, bidirectional, link-on-write
  readonly sourceKeys: readonly string[];
}
```

Core operations:

- **`recordEpisode`** — snapshot `sha256(file)` for every path (Node `crypto`, streamed 64 KiB
  chunks, `OSError → skip` fail-soft); append JSONL; when pending ≥ `evolveEvery` → `consolidate()`.
- **`replay(key)`** — hit **only if every stored hash still matches** (any drift → miss). This is
  the 0-token path: v5 measured `10,051 → 0 tok` on the repeat run.
- **BM25 over `note.blob()`** (`content + context + keywords + tags + paths + symbols`;
  tokenizer: lowercase, `_`/`-` → space, `[a-z0-9]{2,}`). ~40 lines; corpus is notes (dozens), not
  the repo — the sandbox `search` BM25 in `retrieval.py` is untouched, different corpus, no DRY
  violation (v5 also has two).
- **`consolidate(llm)`** — batched A-MEM-lite: build ONE prompt from pending episodes → host's
  single completion entry point (`bridge/model.ts`, DRY rule: only file calling `completeSimple`)
  → parse note list → fallback: one note per episode verbatim. No per-write evolve (v5 explicit).
- **`injectBlock(query)`** — `""` when no notes (v1 burned ~90 chars/turn — keep silent); char
  budget = `injectNoteTokens × 4`, top-6 by relevance, per-note content ≤ 280 chars, greedy fill,
  hard break at overflow. Header: `[memory] retrieved notes (do not restudy these paths unless hashes went stale):`.

All writes fail-soft: `Promise<Result<boolean, string>>`-style, warn via emitter, never throw.

### 7.3 Engine gates (read-only runs replay + persist)

The plugin engine never writes the workspace — every `rlm()` child run is v5-"readonly":

- **Before spawning a child** (in `rlm-query.ts` handler, where `childRun` is called):
  `taskKey("rlm", prompt, paths, model, contextSig(childContext))` → `memory.replay(key)` → hit ⇒
  return `RlmResult` with `iterations: 0`, trace `{ replay: true }`, `usage.memoryHits++` — **zero
  API calls**.
- **After a child completes with an answer**: `recordEpisode(...)` unconditionally (v5 does the same
  for child sub-RLM results).
- Root/interactive native runs: record only when a run produced a final answer (same `_persist`
  discipline); **never** record partial turns.

### 7.4 Sandbox surface + interrupts

Worker scaffold (in the new `scaffold.py`): `memory.query(q, k=8)`, `memory.add(text, paths=…,
tags=…)`, `memory.stats()` — thin shims posting `memory.*` interrupts (same checklist as §6.3).
Advertised in the REPL header line (v5 verbatim style):
`memory.query(q) / memory.add(text, paths=…) / list_claims() — durable + inflight`.

### 7.5 Config + tests

`enableMemory: boolean (true)`, `injectNoteTokens: number (2_000)`, `evolveEvery: number (8)`,
`memoryDir: string | null (null → <root>/.rlm/memory)`.
`test/memory.ts`: record→replay round-trip; hash drift invalidates; empty-inject `""`; inject budget
respect; consolidate fallback without llm; JSONL trim at cap. Add `.rlm/` to `.gitignore` (Phase 0).

---

## 8. Phase 4 — Provider-aware concurrency caps

What exists (keep!): `util/concurrency.ts` — `Semaphore` (L23–49), `DepthGates` per depth (L59–72),
`SubcallGates` (L75–93) fed by `maxConcurrentSubcalls: 16` / `maxConcurrentChildren: 6`.
v5's single `max_workers=4` is strictly weaker — we keep ours and add the missing dimension:
**some providers (zai) break with > 4 concurrent agents.**

### 8.1 Config

```ts
// core/types.ts
/** Per-provider concurrent-request caps, resolved against the models actually in use.
 *  The effective gate is min(maxConcurrentSubcalls, cap of every provider involved).
 *  Example: { zai: 4 } */
readonly providerMaxConcurrent?: Readonly<Record<string, number>>;
```

### 8.2 Resolution (in `mode/` where models are already ranked — worker-model.ts)

```ts
export function effectiveSubcallLimit(
  config: RlmConfig,
  providersInUse: readonly string[],   // from the ranked worker model + root model
): number {
  let limit = config.maxConcurrentSubcalls;
  for (const p of providersInUse) {
    const cap = config.providerMaxConcurrent?.[p];
    if (cap !== undefined && cap > 0) limit = Math.min(limit, cap);
  }
  return limit;
}
```

`createSubcallGates` is constructed with `effectiveSubcallLimit(...)` and, separately,
`min(maxConcurrentChildren, providerMaxConcurrent of the child model provider)` for `DepthGates` —
children are the "agents" that hurt (each holds a Python subprocess + a full inherited context
copy; the 16/6 split comment in defaults.ts already says exactly this).

### 8.3 UX

`/rlm-config` panel: one row per configured provider (`provider: zai`, `cap: 4`); status line
additions: `budget 34%·soft | led 2✓1↺ | mem 1 hit | gates 6/16`. All fields validated with
existing helpers.

### 8.4 Tests

`test/concurrency-provider.ts`: gate resolves to min(); unknown provider → base limit; child gate
independent of leaf gate; a `{ zai: 4 }` config actually serializes the 5th concurrent spawn.

---

## 9. Phase 5 — Role separation (capability matrix enforcement)

Target matrix (v5 doctrine):

| Role in the plugin | REPL | edit | read/grep | llm calls |
|--------------------|------|------|-----------|-----------|
| Pi main agent (native mode) | own tools | **yes** (its own edit tools) | yes | — |
| root `repl()` tool session | full sandbox REPL | via main agent | `search`/`grep_context`/`outline` | yes |
| `rlm()` child engines | **delegation + memory/ledger only** | **no** | **no** — context arrives via `getChildContext` pack text; slices go to llm prompts | yes |
| `llm_query` leaves | none | no | no (text-in) | no |

### 9.1 Implementation — surface flag, not code forks

`SandboxManager.getOrCreate()` / exec-init gains `readonly surface: "root" | "child"`. Worker
boot: when `surface === "child"`, `_restore_scaffold` installs **only** the delegation set
(`llm_query`, `llm_batch`, `llm_query_chunked`, `spawn/await_task/list_tasks`, `map_files`,
`memory.*`, `list_claims`) — **no** `search`/`grep_context`/`outline`/`add_context`. Root keeps
everything. One conditional list at one site — no duplicated scaffold.

```ts
// core/types.ts
/** v5 doctrine: child engines delegate (llm + memory/ledger) and do not explore the repo
 *  themselves — retrieval belongs to the root. "legacy" keeps today's full child surface. */
readonly childSurface: "delegation" | "legacy";
// default: "delegation"
```

`"legacy"` is the rollback switch: one config flip restores today's behavior (don't-break contract).

### 9.2 Prompt updates (`prompts/glossary.ts` → system + native)

- Root: unchanged (retrieval + delegation is already its contract).
- Child header (v5 `rlm_worker.py` "ONLY these" style): closed API list + the ledger doctrine line
  (§6.3) + `[runtime] you are depth=N; rlm_query only for a disjoint path set.`

### 9.3 What we deliberately do NOT port

v5's classic-root `edit_fn`/`write_fn` fs handlers. The plugin's engine is **no-disk-I/O by design**
(AGENTS.md) and the main Pi agent owns editing. Adding fs writes to child engines would be a
security-surface regression for zero measured benefit. "The rlm agent can edit" is satisfied at the
architecture level: the **root** (main agent + native repl session) edits; children only propose.
*(If you want opt-in child edits later, it's a separate RFC — flagged in Open Decisions.)*

### 9.4 Tests

`test/child-surface.ts`: child scaffold has no `search`/`grep_context`/`outline`/`add_context`;
root unaffected; `childSurface: "legacy"` restores full list; child context still inherited via
`getChildContext` (regression for DRY rule 6 / issue #4).

---

## 10. Final config reference (all phases)

| Field | Default | Phase | Meaning |
|-------|---------|-------|---------|
| `enableTokenBudget` | `true` | 1 | budget governs run length |
| `budgetShare` | `0.25` | 1 | cap = share × contextWindow |
| `budgetSoftFrac` | `0.8` | 1 | soft wrap-up threshold |
| `budgetTaskCap` | `400_000` | 1 | absolute single-run ceiling |
| `budgetMaxContinuations` | `2` | 1 | chain cap (root + 2) |
| `budgetHandoffChars` | `4_000` | 1 | distill handoff size |
| `enableLedger` | `true` | 2 | blackboard on/off |
| `rlmBudget` | `8` | 2 | rlm spawns before llm demotion |
| `enableMemory` | `true` | 3 | `.rlm/memory` on/off |
| `injectNoteTokens` | `2_000` | 3 | `[memory]` char budget = ×4 |
| `evolveEvery` | `8` | 3 | episodes per consolidate |
| `memoryDir` | `null` | 3 | override (null → `<root>/.rlm/memory`) |
| `providerMaxConcurrent` | `undefined` | 4 | e.g. `{ zai: 4 }` |
| `childSurface` | `"delegation"` | 5 | v5 child doctrine; `"legacy"` = today |
| *(unchanged)* `maxTokens` | `undefined` | — | absolute tree backstop (throw) — stays |
| *(unchanged)* `execTimeoutS`, `requestTimeoutMs` | 120 / 900k | — | **hang backstops only** (docs) |

## 11. New/changed files & line budget (1k rule)

| File | New/Δ | Est. lines |
|------|-------|-----------|
| `core/budget.ts` | new | ~230 |
| `core/model-registry.ts` | new | ~120 |
| `core/ledger.ts` | new | ~260 |
| `core/memory.ts` | new | ~380 |
| `sandbox/py/scaffold.py` | new (Phase 0 move + Ph2/3 additions) | ~380 |
| `core/engine.ts` | Δ +~60 (budget state + continuation + injection calls) | ≤ 410 |
| `core/compaction.ts` | Δ +~60 (G1 elision) | ≤ 180 |
| `core/types.ts`, `config/defaults.ts`, `config/settings.ts` | Δ config fields | +~90 total |
| `bridge/handlers/task-registry.ts` | Δ ledger coalesce + demotion | ≤ 300 |
| `sandbox/protocol.ts`, `sandbox/interrupts.ts`, `sandbox/py/worker.py` | Δ interrupt types | +~120 total |
| `prompts/glossary.ts` | Δ doctrine lines | +~30 |
| `test/budget.ts`, `test/ledger.ts`, `test/memory.ts`, `test/concurrency-provider.ts`, `test/child-surface.ts` | new | ~150 each |

## 12. Test & verification plan

1. **Per phase:** unit suites above, registered in `test/smoke.ts`; `bun test` green before merge.
2. **Budget live gate** (mirrors `e2e-v4`): forced small cap (`budgetTaskCap: 12_000` on a small
   task) must stay **correct** via continuation; log `budget_soft`/`budget_continuation` events;
   assert chain ≤ 2 and cumulative tokens ≈ cap × (1 + continuations tolerance).
3. **Ledger offline gates** (mirrors `e2e-v2`): `dup_spawn` → 1 subcall; echo → stub; near-dup →
   coalesce.
4. **Memory gates** (mirrors `mem_suite`): record → replay 0-API-call; hash-drift miss; inject
   silence on empty store.
5. **Regression:** every existing phase1…phase-* suite unchanged and green (the don't-break
   contract); `childSurface: "legacy"` must make the child-surface diff a no-op.

## 13. Risks & rollback

| Risk | Mitigation |
|------|-----------|
| Budget soft-note causes premature/wrong finalize (v4 Run-1 flaw, measured) | Port the fix, not the bug: hard branch distills + continues; test asserts continuation fires under cap |
| Continuation recursion adds latency at hard cap | chain ≤ 2 by default; handoff ≤ 4k chars; trace events surface it in UI |
| Ledger coalesces tasks that only *look* identical | `contextSig` fingerprints the haystack; near-dup requires ≥ 0.8 Jaccard or 0.7+same-paths; `enableLedger: false` kills it |
| `.rlm` writes corrupt / grow unbounded | fail-soft writers, JSONL trim at 4,000, gitignored, `enableMemory: false` switch |
| Delegation-only children weaken deep study tasks | `childSurface: "legacy"` one-flip rollback; measure on a study task before/after |
| Provider caps misconfigured → deadlocks | caps only *lower* existing gates; DepthGates already prevents recursive self-deadlock; test serializes, never blocks |
| worker.py split breaks sandbox | pure move in Phase 0, zero logic change, full smoke before Phase 1 starts |

## 14. Open decisions (need your call before the corresponding phase)

1. **Child edits** — keep "root edits, children propose" (recommended, matches no-disk-I/O engine
   design), or add opt-in fs handlers to child engines (v5-style `edit_fn`/`write_fn`) behind
   `allowFs`? *(Phase 5)*
2. **Models cache fetching** — registry can enrich context lengths from OpenRouter like v5, or stay
   fully offline (metadata + fallback table only). Offline is simpler and covers our providers.
   *(Phase 1)*
3. **`[memory]` injection into native root repl()** — v5 injects into MAIN too; for the plugin's
   native mode the main agent is the reader, so inject only on child prompts, or both? *(Phase 3)*
4. **Default `rlmBudget`** — v5 uses 8; our `maxConcurrentChildren` is 6, so 8 demotions rarely
   bind. Keep 8? *(Phase 2)*

---

*Research artifacts for this plan: 7 parallel RLM studies (budget cascade, ledger, memory, async/
concurrency, engines/roles, plugin engine, plugin sandbox) + results-doc extraction, memoized in the
planning session. All v5 constants, templates, and function semantics quoted above are verbatim from
`rlm_test/src/rlm_agent/` source, cross-checked against `CHANGELOG.md` and `result_mem_ledger_v*.md`.*

---

## 15. Execution addendum (post-implementation)

**Status: ALL PHASES LANDED — 26/26 smoke suites green, `tsc --noEmit` clean, every file < 1,000 lines.**

| Phase | Delivered | Test suite |
|---|---|---|
| 0 | `worker.py` 949 → split into `worker.py` (418) + `scaffold.py` (606, pure move); `.rlm/` already ignored; no dead artifacts found | `phase-scaffold.ts` (doc-drift scope updated) |
| 1 | `core/budget.ts` (TokenBudget + distillTrajectory + continuationPrompt), `core/model-registry.ts`, engine cascade (soft note via `buildTurnPrompt.gateMessage`, hard → continuation run, never throws), G1 `elideOldToolPayloads` before `shouldCompact`, 6 config fields | `budget.ts` (34 checks incl. engine-level continuation + chain-cap regression) |
| 2 | `core/ledger.ts` (taskKey/contextSig verbatim v5 semantics incl. `.strip(" .\t")` parity), claim/coalesce/echo/near-dup + waiters, `rlmBudget` demotion, `[ledger]` injection each turn, `list_claims()` interrupt end-to-end, session ledger in native repl tool | `ledger.ts` (38 checks: dup_spawn → 1 runner, echo stub, demotion, engine injection, sandbox surface) |
| 3 | `core/memory.ts` (L1 episodes.jsonl + sha256 invalidation + replay, L2 notes.json + BM25 + link-on-write + batched consolidate with verbatim fallback, injectBlock silence-on-empty), root replay gate (0-API-call), child persist in `childRun`, `memory.query/add/stats` REPL object via `memory` interrupt, `setLlm`/`setRoot` session hooks | `memory.ts` (30 checks incl. engine replay 0-completions, child replay gate, sandbox surface) |
| 4 | `providerMaxConcurrent` config + validation, `effectiveSubcallLimit`/`effectiveChildLimit`, gates built per session at the composition root with models in use, status line `· caps zai=4` | `concurrency-provider.ts` (gate math + real serialization under `{zai:4}`) |
| 5 | `--surface root|child` worker flag, `childSurface: "delegation"|"legacy"` (default delegation), retrieval + add_context stripped from child sandboxes, "ONLY these" doctrine in child system prompt | `child-surface.ts` (worker + engine level, legacy rollback proven); `phase4.ts` pinned to `legacy` (it tests context inheritance, not doctrine) |

**Open decisions — resolved as recommended:**
1. Child edits: kept "root edits, children propose" (engine stays no-disk-I/O).
2. Models cache: offline-first (metadata → `.rlm/models_cache.json` → table → 32k); no OpenRouter fetch.
3. `[memory]` injection: headless root RLM gets it (v5 MAIN parity); native repl tool exposes `memory.query` instead of auto-injecting into Pi's own turns.
4. `rlmBudget`: kept at 8.

**Notable fixes made while porting:** v5 `normalize_prompt` strips trailing periods (`.strip(" .\t")`) — the TS port needed `.replace(/^[ .\t]+|[ .\t]+$/g, "")` to match; llm leaf claims keep the `emitting()` node (usage/UI) with the ledger wrapped around it, not instead of it.

**Deviations from plan (intentional):** §8.3 config-panel row for provider caps was dropped — the `SettingsList` UI is fixed-choices and providers are open-ended; `providerMaxConcurrent` is an rlm.json setting (validated) surfaced on the status line instead.

---

## 16. Audit response — C1–C6, H1–H9, M1–M10 fixed

**Post-audit state: 26/26 smoke suites green (incl. new `composition.ts`), `tsc --noEmit` clean, every file < 1,000 lines.**

| Item | Fix | Regression test |
|---|---|---|
| C1 | `RlmController.buildEngine` seam — the ONE engine construction path for the controller; `start()` now passes `memory` + the session gates; `controller.setSessionGates` wired in `index.ts` | `composition.ts`: probe subclass asserts the engine deps carry the session store + capped gates |
| C2 | ONE `emitSubcallCreated` per `childRun` — the ledger decision node is reused as the run node; echo/coalesce return on it, run reports on it | `ledger.ts`: `created === 1` per rlm_query (run AND echo paths) |
| C3 | `sessionLedger.beginRun(params.code)` / `endRun()` around each native `execWithSetup`, gated with `enableLedger` | `ledger.ts`: cell-restating child stubbed; documented limitation: tool-level UI test needs a runChild seam — follow-up |
| C4 | `formatReplOutputs` prefixes `REPL stdout:` (v5 needle parity); `distillTrajectory` joins findings/states chronologically, next-step hint still newest-first | `budget.ts`: distill over the REAL formatter's output; chronology assertions |
| C5 | `replGlossary(…, delegation)`: retrieval lines, `add_context` docs, search worked-example, ENV_TIPS probe line and the addendum "free search" line all conditional; delegation variants (`DELEGATION_SURFACE_LINES`, `SPAWN_EXAMPLE_DELEGATION`, `RECURSION_DELEGATION_LINES`); native prompt documents `memory.*`/`list_claims` | `child-surface.ts`: child system prompt must not contain `search(`/`grep_context(`; root still must |
| C6 | `buildSessionGates(cfg, smart, worker)`: leaf gate caps against the **worker** provider only, child gate against the **smart** provider; memoized resolver rebuilds on config/model change; `resolveGates` accessor makes the repl tool's gates live | `composition.ts` + `concurrency-provider.ts`: zai-smart caps children at 4, zai-worker caps leaves at 4 |
| H1 | `waitFor(key, timeoutMs=600s)` + immediate reject on errored claims; errored keys re-claimable | `ledger.ts`: timeout fires (<2s), errored reject, re-claim |
| H2 | Continuation chains persist under the **original** root key; `persistRoot` skips continuation leaves, aborted and `(stopped…` partials | `budget.ts`: forced-cap chain → identical re-run replays with 0 completions; maxTokens stop records nothing |
| H3 | `runClaimedLeaf` — one routing helper shared by `llm_query` and **every `llm_batch` item** (map_files/chunked ride llm_batch) | `ledger.ts`: 3 concurrent identical leaf prompts → 1 exec |
| H4 | `markRunning(key)` called by rlm childRun + leaf runner | `ledger.ts`: pending → running observable |
| H5 | `Claim` fully `readonly`; transitions replace the map entry with a new `Object.freeze`d claim | type-level (tsc) |
| H6 | `rootContextPaths(context, 64)` — root episodes snapshot the bounded real-file slice (cwd-seeded, non-`ctx/`) for replay invalidation | `memory.ts`: extraction + bounds |
| H7 | Real chunked `readSync` sha256 (64KiB); `safeAbs` path jail — `../` traversal gets no digest | `memory.ts`: traversal excluded from pathHashes, in-root hashed |
| H8 | `maxTokens` documented as the HARD-ABORT backstop (no wrap/continuation); budget is the graceful path | doc-only |
| H9 | Continuation result sums parent + leaf tokens/cost; leaf receives `liveContext` (grown world) | folded assertions in budget.ts chain test |
| M1 | ONE `ModelContextRegistry` per run; metadata windows `observe()`d into the `.rlm` cache | budget.ts registry tests |
| M2 | `consolidate()` single-flight; JSON parse tries the whole reply before bracket-slicing | `memory.ts`: 2 overlapping consolidations → 1 llm call |
| M3 | `memoryDir` doc: relocates only; the switch is `enableMemory` (dead `dir !== null` check removed) | — |
| M4 | Documented: native repl() session and headless runs keep separate TaskLedgers (per-run blackboard, v5 parity); the MemoryStore IS shared | doc-only |
| M5 | `add_context` handler no longer installed for delegation children (root-only) | covered by C5 suite |
| M6 | FINALIZE_PROMPT unified to the answer-ready dialect; all prompt variants delegation-aware | C5 grep assertions |
| M7 | `subSampling` now `Object.freeze`d like `rootSampling` | — |
| M8 | `isRecord` type guards replace `as Record<…>` casts in `contextSig` + memory parsers | type-level |
| M9 | The eight missing composition-root tests added (see rows above) | `composition.ts` + extensions |
| M10 | "never store secrets/API keys — notes persist on disk" warning in both prompt surfaces | — |

Audit's Low/fidelity notes were left as the audit recommended (offset→fresh-instance accounting, dead `cap<=0` branch, stricter echo thresholds, map_files on child surface).
