# rlm-pi — Project Instructions

## Commands
- Runtime: **bun.js** (use `bun run index.ts`, `bun install`, `bun test` — never npm/pnpm/yarn)
- Source: root `index.ts` (harness) + `pi-plugin/rlm/src/` (the actual RLM plugin)
- TypeScript: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` enabled in both tsconfigs
- Do not commit secrets, API keys, or session files.

## Architecture

This is a **Recursive Language Model (RLM) plugin** for the Pi coding agent. The engine drives a "smart" model turn-by-turn over Python `repl()` blocks, each executing in a persistent Python subprocess sandbox (`sandbox/py/worker.py`). Sub-LLM calls (`llm_query`, `rlm_query`) are serviced in-process by bridges that hold API keys — the sandbox never sees them.

```
pi-plugin/rlm/src/
├── core/          Headless RLM loop, limits, compaction, history
├── bridge/        Sub-LLM/rlm handlers (bridge/handlers/ is the single impl)
├── sandbox/       Python subprocess (py/), JSONL protocol, interrupt dispatch, sandbox manager
├── tool/          repl() and rlm() Pi tool registrations + event emitter
├── config/        rlm.json persistence, defaults, model resolution
├── prompts/       glossary (shared) → system (headless) + native
├── context/       native walker + anydoc document conversion + add_context
├── ui/            Config panel, model picker, status line, theme
├── text/          REPL block parsing, token estimation, text preview
├── mode/          RlmController, native-mode guards
├── util/          Result type, error formatting, concurrency pool
├── commands/      /rlm, /rlm-stop, /rlm-config
└── index.ts       Extension entry point
```

The engine performs **no disk I/O**. There is no run trail, no snapshot, no resume: a run
lives entirely in memory and its answer is its only durable output.

**Entry points:**
- Root `index.ts` — harness that boots Pi with `createAgentSession()`
- `pi-plugin/rlm/src/index.ts` — `rlmExtension()`: registers tools, commands, prompt injection, input routing
- `core/engine.ts` — `createEngine()`: builds the `runRlm` function (headless turn loop)
- `sandbox/py/worker.py` — Python REPL worker: executes model code, bridges sub-LLM calls over stdin/stdout.
  Siblings `guards.py` / `retrieval.py` / `tasks.py` resolve via `sys.path[0]` (the script's own
  directory) — no packaging step, and they ship with `src/` like everything else.

**Key types file:** `core/types.ts` — `RlmConfig`, `RlmInput`, `RlmResult`, `RunRlm`, `Sampling`

**Model-visible surface is deliberately small** (prime-agent's rule): two Pi tools (`repl`, `rlm`)
and a REPL namespace of retrieval + delegation only. There is no `todo`, no `save_artifact`, no
`advance_phase`. Task tracking belongs to the main agent and its own tools, not to the sandbox —
do not re-add a wrapper for something Pi already owns.

## DRY Rules — DO NOT Duplicate

Rules 1–5 below were a standing duplication between the headless engine and the repl() tool.
They are now **resolved**: `bridge/handlers/` (`createSubcallHandlers`) is the single
implementation of `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch`, and
`bridge/llm-query.ts` + `bridge/rlm-query.ts` have been deleted. Keep it that way:

1. **LLM completion logic** — `complete1` exists once, inside `createSubcallHandlers`. Never inline another one; if you need LLM handlers, call `createSubcallHandlers`.

2. **RLM recursion logic** — `childRun` (depth cap → resource guard → spawn engine → debit parent) exists once, in the same file. Callers supply `runChild` and `degrade`, not their own copy of the sequence.

3. **Display model resolution** — one private `displayModel()` in `bridge/handlers/`, built on `modelRef` + `resolveModelId` from `config/settings.ts`.

4. **Leaf answer summary** — `summarizeLeaf()`, exported from `bridge/handlers/`. Batch
   handlers emit ONE node per item (`llm_query`/`rlm_query` rows — nothing collapsed, no `×N`).

5. **The subcall emit pattern** (create → execute → update status/cost/tokens) — the `emitting()` helper in `bridge/handlers/` for leaf sub-calls; `childRun` emits its own node for recursive ones (never wrap it, or the node is reported twice). `bridge/add-context.ts` follows the same shape by hand (extra mid-flight statuses). Adding a new subcall handler? Reuse these — don't invent a new pattern.

6. **Child context inheritance** — `getChildContext` on `SubcallHandlerDeps` is the ONE seam by
   which a child RLM receives its parent's world (repo pack + loaded libraries). `childRun` is the
   only place an `RlmInput` for a child is constructed. A second path here is how issue #4
   happened: whichever path forgets to grow leaves the child blind, and it degrades silently.

**Callers differ only in `resolve`.** The engine binds one `Invocation` for a whole run; the
repl() tool swaps one per turn and routes `spawn()`ed (detached) work to the session-scoped
`BackgroundTasks` registry. If you find yourself adding a second construction path, add a
field to `SubcallHandlerDeps` instead.

## Type Safety Standards

- **ZERO `any`** — use `unknown` always. Currently clean; keep it that way.
- **ZERO `!` non-null assertions** — use `?.`, `??`, type guards. Currently clean.
- **`readonly` where it makes sense** — immutable DTOs, constants, and option bags may use `readonly`; mutable state objects (registries, counters, snapshots, timers) are fine without it. No blanket requirement.
- **`Object.freeze()` on constants** — arrays, sets, default configs, enums must be frozen.
- **Discriminated unions** over flags — never a boolean that silently changes a shape.
- **`Result<T, E>`** (`{ ok: true, value } | { ok: false, error }`) for fallible operations — use from `util/errors.ts`.
- **Fail-soft I/O** — writers return `boolean` and warn instead of throwing; never `console.log` from a
  TUI path (it corrupts the render).
- **Type guards over casts** — every `unknown` must be narrowed via `is*` functions before use.

## Strict Engineering Rules

- **The DRY principle is absolute**: we never copy/paste or duplicate logic/code!
- **No dynamic types!** Always use strict TypeScript typing. If a type is unknown, using `any` is strictly forbidden — always use `unknown`. Ensure `"strict": true` is enabled in `tsconfig.json`.
- **Strict null/undefined safety**: NEVER use the non-null assertion operator (`!`) to force-unwrap or bypass the compiler. Always use safe checks: optional chaining (`?.`), nullish coalescing (`??`), or explicit Type Guards.
- **No unhandled exceptions (no crashes)**: Avoid application crashes. Use try/catch blocks for critical sections, or prefer the `Either` pattern / Discriminated Unions for compile-time error handling (functional programming style).
- **Heavy tasks out of the main thread**: Never block the Event Loop. Parsing massive JSON strings, cryptography, or heavy mathematical computations must be offloaded to Web Workers (browser) or Worker Threads (Node.js).
- **Zero extra allocations in the UI**: Prevent wasted renders and memory leaks. In UI frameworks (React, Vue, etc.), use memoization (`React.memo`, `useMemo`, `useCallback`) wherever justified. For immutable configurations and constants, always apply `Object.freeze()` (freezing a `string`/`number` is pointless — they are immutable by nature).
- **Keep components and render functions pure and fast**: No business logic, heavy calculations, or side effects inside the component body or JSX/templates. Only UI declaration.
- **Optimize memory collections**: Avoid creating empty arrays and continuously calling `.push()` in loops if the collection size is known beforehand. Pre-allocate memory using `Array.from({ length })` or `new Array(size)` to prevent ongoing V8 engine reallocations.
- **Efficient string manipulation**: Never use string concatenation (`+` or `+=`) inside heavy loops. For assembling large volumes of text, push segments into an array and use `.join('')` to minimize the creation of intermediate strings in memory.
- **Data predictability and comparison**: For data objects (DTOs/Value Objects), mark all properties as `readonly`. Mutable runtime state (registries, counters, timers) is fine without it. If value-based (instead of reference-based) object comparison is required, explicitly implement `equals()` / `hashCode()` methods or utilize proven deep-equality libraries.
- **Safe FFI/Wasm memory management**: When integrating with low-level code via WebAssembly (Wasm), Node-API (N-API), or Bun FFI, strictly manage allocated memory. Always manually free native memory and destroy references to prevent memory leaks outside the V8 heap.
- **Follow best practices**: Enforce strict ESLint rules (including `@typescript-eslint/eslint-plugin` with `strict-type-checked` configurations), Prettier, and the official style guides of your chosen framework.
- **Optional props use `?` syntax** — never write `prop: string | undefined` in interfaces or option bags; write `prop?: string`. The explicit `| undefined` union is the same thing but noisier — `?` is the convention.

## Patterns to Follow

| Pattern | Example |
|---------|---------|
| Single model completion entry point | `bridge/model.ts` — the only file that calls pi-ai's `completeSimple` |
| Error formatting | `formatError(msg)` returns `"Error: msg"`, `isErrorText()` detects it — never throw strings |
| Concurrency pool | `util/concurrency.ts` `SubcallGates` — one session-wide `Semaphore` for leaf completions, per-depth `DepthGates` for child engines (a single shared gate would deadlock on recursion) |
| REPL block extraction | `text/parsing.ts` `findReplBlocks(text)` — regex over fenced code blocks |
| Sandbox lifecycle | `SandboxManager.getOrCreate()` → `exec(code)` → serialized queue, death-recreate on failure |
| Event emission | `RlmEmitter` (typed EventEmitter) → `SubcallStore` (accumulator) → `RlmEventAggregator` (snapshot) |
| Config validation | `settings.ts` `validateNumber(v, min)`, `validateBoolean(v)`, `validateString(v)` — all accept `unknown` |
| Pre-allocated arrays | `new Array<R>(items.length)` before loops, never `.push()` in a loop |
| JSONL protocol | `sandbox/protocol.ts` — newline-delimited JSON, parent→worker requests, worker→parent interrupts |
| Async sub-calls | `py/worker.py` posts a request and parks the reply by rid (`_post` / `park_reply` / `_drain_until`); `spawn()` returns a `Task`, `await_task` / `await_task` collect it, possibly in a later exec |

## Adding a New Bridge Handler

If a new sandbox function is needed (e.g., `new_tool()` from Python):
1. Add the interrupt type to `protocol.ts` (`WorkerInterrupt` union)
2. Add the handler to the `SubLlmHandlers` interface in `sandbox/interrupts.ts`
3. Implement in `py/worker.py` (Worker class `_new_tool` + RPC)
4. Wire in `bridge/add-context.ts` or a new bridge file — reuse the emitter pattern
5. Register in `sandbox/interrupts.ts`: the `SubLlmHandlers` interface, the `REJECT` default,
   and the `serviceInterrupt` dispatch
6. Register in `py/worker.py` `RESERVED` + `_restore_scaffold`

## SKILL.state Integration Conventions

The SKILL.state integration (full plan: `/tmp/SKILL_STATE_INTEGRATION_PLAN.md`) replaces
append-only history with execution state `Σ_t` and adds a persistent SkillState store. All code
in these workstreams obeys the standards above PLUS:

- **Notation in comments**: use the paper's symbols — `P` (immutable spec/system prompt),
  `Σ_t` (execution state), `ΔΣ_t` (model patch), `⊕` (deep-merge, `null` = delete),
  `V(ΔΣ_t, Σ_t)` (deterministic validator), `A_t = (P, Σ_t, O_t)` (per-step inputs), `Ξ`
  (injected skill block), `κ_Σ` (state byte cap). Comments referencing SKILL.state cite
  section numbers (§3.2, §5.7, §7).
- **One merge implementation**: `util/state-merge.ts` `deepMergeWithNullDeletion` is the only
  merge for both RunState (Σ) and SkillState notes. Never inline a second merge.
- **State is validated runtime-side, never model-side**: patches arrive as `unknown`, narrow
  via `is*` type guards, return `Result<RunState, PatchError>` from `util/errors.ts`.
  Implicit key drops are errors (`implicit-drop`), not silent keeps — small models overwrite
  keys prematurely (paper §5.7: 68% of failures).
- **Degrade, never crash**: RunStateTracker is a discriminated union
  (`active | degraded`); on retry-cap exhaustion the engine falls back to as-built
  append-only + `compactHistory` behavior. No throw paths in the turn loop.
- **Persistence mirrors `config/settings.ts`**: new disk artifacts use
  `join(getAgentDir(), name)` path helpers, fail-soft readers (`try/catch` → frozen empty
  value), fail-soft boolean writers (`mkdir` → `writeFile` → `true | false`). No second I/O
  style. Three-state pins: `undefined` = merge-from-disk, `null` = explicit clear.
- **No session state at module load**: `NATIVE_PROMPT_STATIC` / `NATIVE_PROMPT_BUDGET` are
  frozen import-time snapshots — never bake per-session text into them or any module-level
  const. Dynamic text enters via function arguments (`PromptMeta.skillBlock?`,
  `before_agent_start` concat) only.
- **One leaf-completion seam**: grounding attaches inside `completion.ts:complete1` via
  `SubcallHandlerDeps.groundLeaf?` — never per-handler prompt surgery (DRY #1).
- **One child-construction seam**: `childRun` copies `skillBlock` into child `RlmInput` —
  no second child-input path (DRY #6).
- **Compact serialization**: state JSON uses `JSON.stringify(Σ)` (no pretty-print, paper
  A.4); caps (`RUN_STATE_LIMITS`) are `Object.freeze`d and enforced before every persist —
  state size must stay flat across iterations.
- **BM25 duality is documented, not accidental**: `sandbox/py/retrieval.py:_Bm25Index`
  (sandbox) and `util/bm25.ts` (host) implement the same scoring for two runtimes; keep their
  constants identical.
- **New sandbox functions**: follow "Adding a New Bridge Handler" (§ above) in full —
  interrupt type, `SubLlmHandlers` + `REJECT` + dispatch, worker method + `RESERVED` in
  `guards.py`/`worker.py`, glossary line. Model-visible surface grows only when the profit is
  proven.

## Root Σ Integration Conventions (WS-1..WS-4)

The Root Σ plan (`/tmp/ROOT_SKILL_STATE_PLAN.md`) brings SKILL.state to the native Pi harness
orchestrator through public plugin seams only — no host modifications. Conventions on top of
the SKILL.state rules above:

- **RootStateTracker** (`core/root-state.ts`) is runtime-derived (tool outcomes, engine-run
  mirrors via the ONE `EngineDeps.onRunState` seam, the user's latest prompt). The root's Σ is
  a digest, never model-authored by default; the fence protocol (`enableRootStateFences`)
  is the only model-proposed input, is OFF by default (paper §5.7 fence tax), and rides the
  same `V(ΔΣ_t,Σ_t)` ladder + retry/degrade semantics as engine runs (cites §3, §5.3, §5.7).
- **`session_before_compact` seam** (WS-2): `core/root-digest.ts` supplies a deterministic
  no-LLM digest. Cut points only ever TIGHTEN Pi's boundary (never extend) and every
  displaced message folds into the digest inputs — nothing is dropped unaccounted. Never
  return `cancel: true` (overflow recovery depends on compaction happening).
- **`context`-event discipline** (WS-3): handlers receive a `structuredClone` — mutate it in
  place (zero extra allocations), return `{ messages }`; the disk transcript is never touched
  (context is the query channel, the session log is the archive). Every handler body is
  wrapped fail-soft: a throw must return the identity, never break the turn (host contract
  `packages/agent/src/types.ts:191`). The Σ snapshot self-identifies via
  `customType: "rlm-sigma"` and elision must keep it immune.
- **"No session state at module load" also covers event handlers**: per-session state
  (`rootTracker`, telemetry counters, the skill store) lives in the `rlmExtension` closure —
  module-level consts stay frozen import-time snapshots.
- **One wording source**: digest header/section labels and the skill_search recall line live
  in `prompts/glossary.ts` (`ROOT_DIGEST_*`, `SKILL_RECALL_LINE`); `runStateRootBlock` composes
  from them instead of re-wording.
- **Bench A/B**: `RLM_BENCH_NO_ROOTCONTEXT=1` skips the WS-3 transform at the gate
  (`rootContextActive()` in index.ts); telemetry is journal-only (`trace` + closure counters:
  `xiCompositions`, `rootDigests`, `elidedMessages`, `sigmaSplices`).

## Testing
- Tests live in `pi-plugin/rlm/test/`
- Phase-based tests: `phase1.ts` … `phase-*.ts`; `test/smoke.ts` runs every suite and boots a real sandbox
- `native-smoke.ts` and `native-mode.ts` test the repl() tool integration
- `helpers.ts` provides test utilities
