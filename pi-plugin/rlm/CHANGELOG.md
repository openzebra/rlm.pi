# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A dying Python worker could take the whole pi session down.** `PythonSandbox` attached
  listeners to the child process and to stdout/stderr, but never to `proc.stdin`. A write to a
  dead worker's pipe fails *asynchronously* — node emits `'error'` on the stream, and an
  EventEmitter `'error'` with no listener is an `uncaughtException`, which neither the
  `try { send(…) } catch {}` in `dispose()` nor the `try { await dispose() } catch {}` in
  `SandboxManager` can intercept. The deterministic route in: the request watchdog SIGKILLs the
  worker, `SandboxManager` disposes it, and `dispose()` writes a `shutdown` frame to the corpse →
  `write EPIPE` → process exit, losing session history and REPL state over a worker that was
  meant to be disposable. Now every stdio pipe has an `'error'` listener that records to the
  bounded stderr tail; `send()` drops frames for a dead worker instead of writing (and never
  throws — `reply()` calls it from a catch block); `request()` rejects up front rather than
  waiting for the watchdog; and `dispose()` only handshakes a live worker.
- **Worker deaths now say what happened.** The `exit` handler reports `signal SIGKILL` vs
  `code 1` alongside the stderr tail, so the surviving `REPL error: …` distinguishes a watchdog
  kill, an abort, an OOM kill, and a Python-level crash.
- `dispose()` waits for the worker's actual `exit` event (bounded) instead of sleeping a fixed
  50 ms on every teardown.

- **Child RLM context inheritance ([#4]).** A recursive `rlm_query` child received the prompt
  string as its *entire* `context`, so it had no repository files and no libraries — ever.
  `load_library()` made it visible: the parent would reference `lib/<id>/…` paths, the child
  would try to resolve them as real directories, fail, and answer from general knowledge with no
  error surfaced. Children now inherit the parent's live context (repo pack + every loaded
  library) under the same paths, with `search` / `grep_context` / `outline` / `map_files`
  working. The prompt becomes the child's question, as at depth 0. This costs **zero extra LLM
  tokens** — only a size line reaches the model; the content lives in the sandbox.
- **`contextLength` under-reported file bundles by ~200×.** It summed `String(entry).length`,
  i.e. `"[object Object]"` (15 chars) per file, so a 3,000-char two-file context reported 30.
  That number is what the model is told to size its batches against, and it is replayed into the
  rebuilt system prompt on `/rlm-resume`.
- **`load_library` could report `already_loaded` for a library that was never appended.** The
  host committed the sidecar index and loaded-prefix on *pack* success, while the worker could
  still refuse (non-list context, or a source that packs to zero files). Both refusals are now
  pre-flighted host-side with the worker's exact wording, before anything is committed.
- **Libraries were lost on sandbox death-recreate (native mode).** `SandboxManager.contextPayload`
  was never updated after a `load_library`, so a recreate silently replayed a repo-only context.

### Added

- **`rlm_query(prompt, paths=['src/auth/', 'lib/x-9f3a/'])`** — narrow a child's inherited context
  to path prefixes (prefix match, not globs). A prefix that matches nothing hands over the full
  context and says so in the child's prompt, rather than blinding it.
- **`maxConcurrentChildren`** (default 3) — child engines are now bounded separately from leaf
  sub-calls (`maxConcurrentSubcalls`, default 6). Each child is a Python subprocess holding its
  own copy of the inherited context, so the previous shared limit allowed up to 18 concurrent
  repository-sized workers.
- Context files are serialized once per payload version and shared by refcount across every
  child that inherits it, in bounded chunks so a large repository never blocks the event loop.

### Changed

- **Cost profile of `rlm_query`.** A child that used to see a 2 KB prompt now sees the whole
  repository and has `maxIterations` turns to spend on it, so a fan-out of N children is N real
  repository analyses. Budget and timeout still descend as *remaining* amounts, so the tree
  cannot exceed the root cap.

[#4]: https://github.com/openzebra/rlm.pi/issues/4

## [0.2.1] - 2026-08-08

### Fixed

- **Batch gate deadlock.** `llm_query_batched` re-acquired the session-wide leaf semaphore
  around each prompt *and* inside every `complete1`, so any batch of ≥ `maxConcurrentSubcalls`
  (default 6) filled the gate and hung forever — including `map_files` / `llm_query_chunked`.
  Batches now fan out with a single acquire per prompt; `Semaphore.map` is gone.
- **Unbounded `rlm_await`.** The worker no longer pauses the cell alarm while draining host
  replies; a re-armable stall alarm (`--await-timeout`, default 600s) raises inside the
  ```repl``` block if the host goes silent.
- **ESC during `repl()`.** Execution `AbortSignal` is wired through to the sandbox request and
  SIGKILLs the worker (REPL variables reset — documented price of interrupt).

- **`spawn(map_files, …)`.** The native glossary promised "start any query fn above" while the
  worker allowlist admitted 5 of 7, so the documented default for bulk reading could not be
  detached. `map_files` is now a builder like the others (`_start_map_files` + a pure regroup
  reducer) and posts every batch at once — a >20-file map costs one round-trip instead of
  `ceil(n/20)`. `llm_map_reduce` stays excluded (its reduce depends on its own map results) and
  the prompts + the `spawn()` error now say so instead of over-promising.
- **`todo` with an unknown action** reported `task #? not found`, sending callers hunting for a
  task instead of fixing the action name. The action is validated before the id lookup.
- **`llm_query("")`** reached the model, which confabulated an answer that then sat in `answers`
  looking like data. Empty (and all-blank batch) prompts are refused up front.
- **Missing builtins fail at startup.** `_builtin()`'s `getattr(..., None)` fallback would
  silently inject `None` and surface much later as `'NoneType' object is not callable`; the
  worker now raises at import instead.
- **Blocked builtins explain themselves.** `eval`/`exec`/`compile`/`input`/`globals`/`locals`
  were bound to `None`, so reaching for one gave a bare `'NoneType' object is not callable` —
  indistinguishable from a corrupted namespace (an audit session spent six execs on this and
  filed a phantom bug). They now raise `PermissionError` naming the block and pointing at the
  supported alternative, at the point of failure and at no cost to prompt budget.

### Added

- **Live background tree.** Detached `spawn()` work is merged into the progressive repl card
  (`↯N bg` stats + `↯bg` node tags) so in-flight sub-calls are visible while they run.
- **Spawn misuse → stderr.** `_surfaced_error` prints `[rlm] …` into the cell so a string that
  later breaks `tasks.items()` is not a mystery.
- **Silent blocks list their REPL vars.** A block that stores results in `answers` and prints
  nothing returned a bare `(no output)`, so the model assumed the work was lost and re-ran it —
  paying for every sub-call twice. Native mode now appends the same var-list hint the headless
  engine has always used (`core/answer.ts`).
- **`RLM_TRACE_FILE` JSONL tracer** and **`bun run test:e2e "<task>"`** — real pi + OpenRouter
  harness with merged root/repl/sub-call timeline and a deadlock stall watchdog.
- **`phase-batch-gate.ts`** — token-free regression: 20 prompts through a limit-6 gate must
  finish fast with peak ≤ 6.

## [0.2.0] - 2026-08-01

### Added

#### Deterministic retrieval inside the REPL

The paper's trajectories retrieve by having the root model hand-write regex (App. E.1).
Frontier models do that well; small/fast worker models guess keywords badly, and the first
decomposition attempt disproportionately decides the outcome (§5, Fig. 4a). These primitives
cost **no tokens and no sub-calls** — they return pointers, and the model chooses what to delegate.

- **`search(query, k=10, path_glob=None)`** — pure-Python Okapi BM25 over 40-line windows of
  `context`. Returns `[{path, line, score, snippet}]`. The index is built lazily on first use and
  rebuilt when `context` is replaced or resized (so `load_library` is picked up automatically).
  The tokenizer splits `snake_case` **and** `camelCase`, so `"resolve model id"` matches
  `resolveModelId`.
- **`grep_context(pattern, k=50, path_glob=None, before=0, after=0)`** — regex over `context`.
  Returns `{hits, counts, total, truncated}`; `counts` stays **complete even when `hits` is
  capped**, so a wide pattern reports its shape instead of flooding stdout. Bad regexes come back
  as `"bad regex: …"`, never as an exception.
- **`outline(path)`** — definition/heading skeleton with line numbers. Matches exact path, then
  suffix, then glob. Orient in ~200 chars instead of printing 20K.

#### One-line delegation

Structural pressure toward orchestrating: delegating is now cheaper to write than solving.

- **`map_files(files, prompt, model=None) -> {path: answer}`** — accepts context entries or
  paths, packs them into cap-sized **batched** sub-calls, and splits oversized files
  automatically. Replaces the hand-rolled chunk loop the prompt used to teach.
- **`llm_map_reduce(items, map_prompt, reduce_prompt, model=None)`** — the paper's canonical
  strategy (query per chunk → aggregate the buffers) as a single call.
- **`answers` / `plan`** — two dicts seeded by the scaffold but **owned by the model**: they
  persist across every turn, appear in `SHOW_VARS()`, and are captured by snapshots, so a memoized
  result survives a resume.

#### Decomposition doctrine in the system prompt

Port of the paper's Appendix C.3 `<env_tips>`, retargeted from competition math to repository
analysis — the single highest-leverage prompt intervention it reports (+69.5% on LongCoT-mini,
Table 2). Full version headless, condensed in native mode, including the red-flag list
("printing file bodies to read them", "regex used to infer meaning", "two turns into an analysis
with zero sub-LLM calls"). The existing anti-**over**-recursion batching rule stays as its
counterweight: the paper is explicit (App. B) that both guardrails are needed and that one prompt
does not port across models.

#### Other

- `--rlm` CLI flag; `/rlm-resume <TAB>` completes real run ids.
- Live context usage (`ctx NN%`) in the footer status line, refreshed each turn.
- `promptSnippet` / `promptGuidelines` on the `repl` tool.
- `compactionThresholdPct` and `requestTimeoutMs` are now editable in `/rlm-config` (both were
  validated and defaulted but had no UI).
- `test/phase-retrieval.ts` — 28 assertions over the new primitives against a real sandbox.

### Changed

- **Sub-LLM and recursion bridges are now a single implementation (breaking, internal).**
  `bridge/llm-query.ts` and `bridge/rlm-query.ts` take accessor-shaped options
  (`workerModel()`, `config()`, `emitter()`, `parentId()`, `depth()`, `remainingBudget()`), so the
  headless engine (binds once per run) and the native `repl` tool (swaps per invocation) share
  them. The drifted second copies inside `repl-tool.ts` are gone (−166 lines), taking the
  credits-hint divergence with them.
- **`RlmConfig` is fully `readonly` (breaking, internal).** `applySetting` is pure and returns a
  new frozen config; `RlmController.setConfig` replaces the reference. Removes `MutableSampling`
  and a latent throw when a frozen `DEFAULT_CONFIG.subSampling` was mutated in place.
  `ReplToolDeps.config` became `getConfig()` so `/rlm-config` edits take effect without a restart.
- **`core/engine.ts` split** 801 → 600 lines. Pipeline state (phase, per-phase latest save, ask
  rounds, pending history reset) moved into a `PipelineController` in `core/pipeline-handlers.ts`;
  validate-phase finalize routing now returns a `reject | loop-back | halt | accept` union instead
  of inlining 70 lines in the turn loop.
- `NATIVE_PROMPT_BUDGET` 6,000 → 7,500. The native prompt grew only 745 chars net (5,825 → 6,570)
  because the doctrine superseded the old Orchestrator Pattern / Workflow / chunk-loop sections.
- Markdown rendering derives its theme from the **injected** `Theme` (`ui/theme-adapter.ts`)
  instead of pi's module-global `getMarkdownTheme()`, which can be uninitialized inside a
  jiti-loaded extension.
- The tool-card expand hint uses the user's real keybinding instead of a hardcoded `Ctrl+O`.
- The `/rlm-resume` progress widget is a component factory, not the `string[]` form — the latter is
  hard-capped at 10 lines, which the live sub-call tree exceeds as soon as a run fans out.

### Removed

- `mode/input-router.ts` and its suite, plus the no-op `input` handler. The module was
  production-dead while `ui/intro.ts` advertised the routing to users; the intro text now
  describes what RLM mode actually does.
- Zero-caller exports: `statusGlyph`, `kindLabel`, `subcallRunningGlyph`, `hasReplBlock`,
  `SubcallInit`, `AskUserQuestionReply`, `clearCache`, `refreshWatchdog`, `hasSavedModels`,
  `RlmHandlers.childRun`, `WorkerResponse.skipped` / `.restored`, and the unused `index` /
  `phaseGuidanceText` parameters.

### Fixed

- **`ThinkingLevel` from a hand-edited `rlm.json` is validated**, not cast. `"off"` and `"max"`
  are not `ThinkingLevel`s and were previously forwarded straight to the provider. The guard is
  keyed by the union, so a level added upstream is a compile error rather than a silent rejection.
- Sandbox stderr keeps a bounded tail instead of rebuilding and re-slicing the whole buffer on
  every chunk.
- Sub-call duration is suppressed only when timestamps are absent, not when they are `0`.
- `repl` tool registration no longer swallows genuine construction failures — only the expected
  already-registered case is ignored.
- `advancePhase` validates the target with the existing `isPhase()` guard instead of casting first.
- The repomix config literal is bound to repomix's own parameter type (`satisfies`), so an
  upstream API change is a compile error — this class of breakage shipped as 0.1.3.

### Internal

- DRY: one token estimator, one trail-line reader, one `previewText`, one `errorMessage`, one
  `limitsFromConfig`, one `displayModelRef`, and one shared tool-card renderer
  (`cardHeader` / `cardStatsLine` / `renderCollapsedCard`).
- `as` casts 93 → 28; still zero `any` and zero non-null assertions.

## [0.1.9] - 2026-07-31

### Changed

#### `load_library` appends into `context` (breaking)

- **`load_library(source)`** no longer creates `context_1` / `context_2` slots. Packed files are
  **appended into the single `context` list** under namespaced paths `lib/<source_id>/…`.
- Source ids are **fingerprinted** (`lib/utils-<8hex>/`) so two libraries that share a basename
  never collide or silently serve the wrong tree.
- Return value is metadata only:
  `{"source", "source_id", "path_prefix", "files", "chars", "context_len", "already_loaded"}`
  (or an `"Error: …"` string). Do not iterate the return value as files.
  `chars` is the sum of raw content lengths (not JSON-serialized size).
- Single-file sources become one `context` entry (not a bare string payload).
  Files larger than 8 MiB are rejected with a pointer to `llm_query_chunked`.
- Re-loading the same source is **idempotent host-side** (no re-clone, no extra resume sidecar).
- Resume still uses `context.<N>.json` sidecars, but merges them back into `context` on restore
  without duplicating already-present prefixes.
- System / native prompts updated so the agent always searches `context`.

#### Remove `stage_edit` / `apply_edits` — native edit only (breaking)

- **`stage_edit`** removed from the Python sandbox. File changes go through Pi's native
  `edit` / `write` tools only.
- **`apply_edits` tool**, `EditRegistry`, and `text/edits.ts` deleted.
- Native prompts require the root agent to **author** edit bodies itself; sub-LLMs read only.

#### Pipeline is read-only — drop implement phase (breaking)

- Phase graph is now **`clarify → research → blueprint → validate`**.
- Serial implement fanout and plugin-owned write path removed.
- Validate is adversarial **plan** review (not a post-diff check).
- Legacy trails with `phase: "implement"` resume at `blueprint` via `reconcilePhase`.
- Sandbox write modes are blocked during pipeline runs (`open` / `pathlib` / `os.open`) —
  steering against accidental writes, not a hard security boundary.

### Added

- **Preflight artifact critique** on `save_artifact`: same gate as `advance_phase`, with
  `BLOCKER:` / `warning:` lines and advisory checks (Success Criteria, Open Questions, Findings).
  Gate results are memoized so `advance_phase` does not re-run the same floors.
- **Append-only artifacts on validate loop-back**: superseded blueprint refs kept for context
  (status round-trips through resume); a fresh `save_artifact` is still required to re-pass the gate.
- **Warnings channel** on `ReplDetails` / `RlmDetails` (pipeline critique advisories and partial
  sub-call failures with real batch counts).
- Aggregate **`bun run test`** smoke harness (`test/smoke.ts`) over all phase suites and a live sandbox.

### Fixed

- Sub-call failure warnings report real prompt counts for batched calls (e.g. `3/8`, not `1/1`).
- Plan critique checks **per-phase** Success Criteria (not aggregate heading totals).

## [0.1.8] - 2026-07-19

### Added

#### External library context

- **`load_library(source)`** — agent-driven external libraries, docs, or other source trees mid-run.
  Sources: local directory (repomix-packed), single file, or `https://` / `git@` shallow clone.
- Shared host handler for headless engine and native `repl()` (no duplicated bridge logic).
- Headless resume restores library sidecars from `context.<N>.json` / `context.<N>.txt`.
- Config toggle **Library loader** (`libraryLoader`, default on) in `/rlm-config`.

#### Artifact-gated pipeline

- Opt-in phase pipeline (`pipeline: true`): **clarify → research → blueprint → implement → validate**
  with deterministic engine gates (never LLM judgment):
  - artifact `status: ready`
  - plan `phases:` / `phase_count` derive-check against fence-aware `## Phase N:` headings
  - `file:line` citation verification against the repo
  - validation `blockers_count` / `verdict` contract
- **Clarify intake phase**: interviews the user via `ask_user_question` until the task is understood;
  writes a clarifications artifact (`decisions_count` / `open_questions_count` + Problem & Intent /
  Decisions / Open Questions / Non-Goals). Engine gate requires ≥1 serviced ask round (un-gameable).
  When `askUserQuestion` is off, clarify is skipped and the run starts at research.
- `save_artifact(kind, content)` sandbox function; artifacts persist under `.rlm/artifacts/`
  (`clarifications/`, `research/`, `plans/`, `validations/`, `goal/`).
- Verbatim goal capture + pre-run dirty-tree baseline at run start.
- Serial implement fanout: one child RLM per plan phase; edits applied between phases;
  idempotent retry (`already-applied` detection) and create-clobber refusal.
- Bounded validate→blueprint corrective loop (`maxBackwardJumps`, default 2, in `/rlm-config`).
- Root history reset at phase boundaries (artifacts are the only inter-phase channel).

## [0.1.7] - 2026-07-07

### Added

- Enhanced `apply_edits` with line statistics, deduplicated file counts, and structured rendering output.


## [0.1.6] - 2026-07-06

### Added

- Edit-by-reference workflow: `stage_edit` returns edit IDs; new `apply_edits({ids})` tool applies staged edits by ID.
- Answer-by-reference via `details.finalAnswer` field.
- `EditRegistry` with sandbox-lifecycle automatic clear on sandbox discard/new sandbox.
- `ProposedEdit.id` protocol field for stable edit identification.
- `onSandboxDiscarded` hook on `SandboxManager` for lifecycle cleanup.
- Tests for `apply_edits`, answer submission, and registry lifecycle.

### Changed

- Updated system prompt to use `apply_edits({ids})` instead of relaying edits verbatim.

## [0.1.5] - 2026-07-04

### Added

- Hard cap on `repl()` stdout returned to the root model (~4K chars), so printing file bodies
  into the REPL is no longer a free path around the file-reading guards. A shared `capText` core
  backs both the existing bash-result cap and the new repl cap (no duplicated truncation logic).
- Zero-subcall delegation nudge: when a `repl()` call prints >2K chars with no `llm_query` /
  `rlm_query` / batch subcall, a one-line note tells the model to delegate semantic reading
  instead. Suppressed when the call staged edits (legitimate diff output).
- Per-turn orchestrator-contract reminder (`NATIVE_TURN_REMINDER`) appended as the last context
  message on every request, with prior reminders stripped to prevent accumulation.
- Named `NATIVE_PROMPT_BUDGET` constant (6,000 chars) so prompt-budget overruns fail with a
  self-explanatory message.
- Regression guard for the `repl()` result assembly via the exported `buildReplResultText` pure
  function: verifies stdout capping, zero-subcall nudging, and that `STAGED_EDITS` JSON survives
  truncation (appended after the cap) with both nudge-suppression paths.

### Changed

- Fixed a contradictory tail line in the repo-listing injection that told the root model to use
  file-reading tools; it now points at `repl()` + sub-LLM delegation.
- Restructured the native system prompt around enforced runtime rules (blocked tools, repl/stdout
  caps) and an explicit `DELEGATION RULE`, replacing the advisory `ABSOLUTE RESTRICTION` block.
- Sharpened the `repl` tool description to lead with delegation (stdout is hard-capped, so printing
  file bodies is useless).
- Trimmed redundant glossary lines now covered by the enforced-rule banner to hold the prompt
  under budget (5,965 of 6,000 chars).
- `replDelegationNudge` now takes a `delegated: boolean` instead of a fake subcall count; the tool
  layer detects delegation via `.some()` short-circuit.

## [0.1.4] - 2026-07-03

### Added

- `llm_query_chunked(text, prompt, model=None)` REPL helper: auto-splits oversized on-disk text
  into cap-sized chunks and fans them out via `llm_query_batched`, so models delegate semantic
  analysis of large files (profiles, logs, dumps) instead of reading the raw bytes themselves.
- Large-on-disk-file delegation rules and a "files >1MB / gitignored are absent from `context`"
  note in both headless and native system prompts.
- One-time stdout nudge when a REPL variable holds >500K chars of raw text, steering toward
  `llm_query_chunked` / `llm_query_batched`.

### Changed

- Made the phase pipeline opt-in (`pipeline: false` by default). This removes `advance_phase()`
  from the default root prompt and disables phase-stall reminders unless explicitly enabled.
- Reduced phase-stall reminders to the phase gate boundary instead of every turn after the gate.
- Treat REPL `context` as an ordinary persistent environment variable within a run: mutations and
  re-binds now persist, while deleted context slots are re-injected from the original payload.

### Fixed

- Corrected child RLM prompts for string contexts so recursive `rlm_query()` children no longer
  receive repository `list[dict]` instructions for plain text input.
- Preserved final answers when `answer["ready"]` is set before `answer["content"]` later in the
  same REPL block.
- Added mid-turn budget/timeout guards for `llm_query()` and `llm_query_batched()` calls.
- Ensured out-of-turn finalization honors recursive `modelOverride` values.
- Preserved user variables such as `context_summary` in snapshots and `SHOW_VARS()` output.
- Kept the freshest REPL output out of lossy compaction summaries by compacting before appending
  pending stdout metadata.
- Derived prompt-cap guidance from `maxPromptChars` instead of mixing character and token units.
- Stopped executing later ```repl``` blocks after an earlier block raises, and report skipped blocks.
- Kept both head and tail slices when eliding large stdout.
- Ignored stray sandbox parent messages fail-soft during sub-LLM RPC waits.
- Matched fenced `repl` blocks by fence length so inner triple-backticks are allowed.

## [0.1.3] - 2026-06-30

### Fixed

- Repository context packing failed with `Unsupported output file path style: undefined`
  when installed via `pi install npm:@hicaru/pi-rlm`. A fresh `npm install` now resolves
  the `repomix` dependency to 1.16.0, which introduced a required `output.filePathStyle`
  config field with no default. Set `filePathStyle: "cwd-relative"` in the pack config
  (matching the sandbox's CWD-relative file paths). No effect under repomix 1.15.0, where
  the field is ignored.

## [0.1.2] - 2026-06-30

### Fixed

- `todo()` inside `rlm_query` sub-agents now works correctly. The interactive dependencies
  (`onTodo`, `onAskUserQuestion`) were not forwarded to recursive child RLM engines spawned
  from the REPL tool, causing `"todo not configured (no onTodo callback)"` errors.

### Changed

- Moved the Install section in the README above the hero image for better visibility.

## [0.1.1] - 2026-06-30

Packaging cleanup to make `@hicaru/pi-rlm` discoverable on pi.dev.

### Changed

- Removed dead `"exports"` field (Pi loads extensions via the raw path in
  `"pi.extensions"`, not Node's export map).
- Loosened `peerDependencies` (`@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) from `">=0.79.0"`
  to `"*"`, matching the peer-dependency convention used by other Pi packages.
- Added keywords `rlm`, `recursive`, `ai-agent` for better pi.dev search ranking.
- Made `"files"` explicit (`"src"` → `"src/"`).

## [0.1.0] - 2026-06-29

Initial release of `@hicaru/pi-rlm`, a native Recursive Language Model (RLM) extension
for the Pi coding agent.

### Added

- Native RLM engine that runs entirely in-process — no servers, no sockets, no Docker. The only
  external process is a single local `python3` sandbox worker.
- Root orchestrator model driving a persistent Python REPL turn-by-turn (a CodeAct-style harness).
- Long-context delegation to cheap worker models via `llm_query` / `llm_query_batched`.
- Recursive sub-RLM calls via `rlm_query` / `rlm_query_batched` (depth-capped, falling back to
  `llm_query` past the depth limit).
- Bidirectional JSONL-over-stdio protocol to the sandbox; provider API keys never enter it.
- Commands: `/rlm`, `/rlm-stop`, `/rlm-config`, `/rlm-resume`, `/rlm-runs`, and `/rlm-help`.
- Live agent/subagent tree showing status, model, cost, tokens, and duration.
- Always-on JSONL run logs under `.rlm/runs/` with sandbox snapshots and run resume via `/rlm-resume`.
- Code-edit collection surfaced as a review popup (with a `yolo` mode to apply immediately).
- `/rlm-config` settings: smart/worker model selection, max recursion depth, iteration cap,
  budget ceiling, max consecutive errors, per-REPL-block timeout, max concurrent sub-calls,
  trajectory compaction, and toggles for `ask_user_question` and `todo`.

[Unreleased]: https://github.com/openzebra/rlm.pi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.2.0
[0.1.9]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.9
[0.1.8]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.8
[0.1.7]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.7
[0.1.6]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.6
[0.1.5]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.5
[0.1.4]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.4
[0.1.3]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.3
[0.1.2]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.2
[0.1.1]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.1
[0.1.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.0
