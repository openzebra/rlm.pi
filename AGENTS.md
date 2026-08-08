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
├── bridge/        Sub-LLM/rlm/interactive handlers (subcall-handlers.ts is the single impl)
├── sandbox/       Python subprocess (py/), JSONL protocol, interrupt dispatch, sandbox manager
├── tool/          repl() and rlm() Pi tool registrations + event emitter
├── config/        rlm.json persistence, defaults, model resolution
├── prompts/       glossary (shared) → system (headless) + native
├── context/       repomix-based repository packing + caching
├── ui/            Config panel, model picker, status line, theme
├── text/          REPL block parsing, token estimation, text preview
├── mode/          RlmController, worker-model ranking, native-mode guards
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
They are now **resolved**: `bridge/subcall-handlers.ts` (`createSubcallHandlers`) is the single
implementation of `llm_query` / `llm_query_batched` / `rlm_query` / `rlm_query_batched`, and
`bridge/llm-query.ts` + `bridge/rlm-query.ts` have been deleted. Keep it that way:

1. **LLM completion logic** — `complete1` exists once, inside `createSubcallHandlers`. Never inline another one; if you need LLM handlers, call `createSubcallHandlers`.

2. **RLM recursion logic** — `childRun` (depth cap → resource guard → spawn engine → debit parent) exists once, in the same file. Callers supply `runChild` and `degrade`, not their own copy of the sequence.

3. **Display model resolution** — one private `displayModel()` in `subcall-handlers.ts`, built on `modelRef` + `resolveModelId` from `config/settings.ts`.

4. **Batch error summary** — `summarizeBatch()`, exported from `subcall-handlers.ts`.

5. **The subcall emit pattern** (create → execute → update status/cost/tokens) — the `emitting()` helper in `subcall-handlers.ts` for leaf sub-calls; `childRun` emits its own node for recursive ones (never wrap it, or the node is reported twice). `interactive.ts` follows the same shape by hand. Adding a new subcall handler? Reuse these — don't invent a new pattern.

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
- **`readonly` on ALL interface properties** — every interface in this project uses `readonly`.
- **`Object.freeze()` on constants** — arrays, sets, default configs, enums must be frozen.
- **Discriminated unions** over flags — never a boolean that silently changes a shape.
- **`Result<T, E>`** (`{ ok: true, value } | { ok: false, error }`) for fallible operations — use from `util/errors.ts`.
- **Fail-soft I/O** — writers return `boolean` and warn instead of throwing; never `console.log` from a
  TUI path (it corrupts the render).
- **Type guards over casts** — every `unknown` must be narrowed via `is*` functions before use.

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
| Async sub-calls | `py/worker.py` posts a request and parks the reply by rid (`_post` / `park_reply` / `_drain_until`); `spawn()` returns a `Task`, `rlm_await` / `rlm_await_all` collect it, possibly in a later exec |
| Worker-model ranking | `mode/worker-model.ts` `compareWorker` — free first, then widest context window, then provider/id for determinism |

## Adding a New Bridge Handler

If a new sandbox function is needed (e.g., `new_tool()` from Python):
1. Add the interrupt type to `protocol.ts` (`WorkerInterrupt` union)
2. Add the handler to the `SubLlmHandlers` interface in `sandbox/interrupts.ts`
3. Implement in `py/worker.py` (Worker class `_new_tool` + RPC)
4. Wire in `bridge/library.ts` or a new bridge file — reuse the emitter pattern
5. Register in `sandbox/interrupts.ts`: the `SubLlmHandlers` interface, the `REJECT` default,
   and the `serviceInterrupt` dispatch
6. Register in `py/worker.py` `RESERVED` + `_restore_scaffold`

## Testing
- Tests live in `pi-plugin/rlm/test/`
- Phase-based tests: `phase1.ts` … `phase-*.ts`; `test/smoke.ts` runs every suite and boots a real sandbox
- `native-smoke.ts` and `native-mode.ts` test the repl() tool integration
- `helpers.ts` provides test utilities
