# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Native cells silently echoed every `rlm_query`/`rlm_batch` spawn.** `beginNativeCell`
  pushed the cell's own task strings onto the ledger's ancestor stack *before* exec, so each
  literal spawn matched itself and returned the echo stub (`done:true`, cost 0, claim never
  created) — delegation was 100% dead in native mode (a live session's six-task fan-out came
  back as six identical stubs). Restored v5 semantics: ancestors are RUNNING engines only
  (`beginRun`/`endRun` in the engine), the Python-string ancestor extractor is gone, the echo
  message is v5's actionable text, and suppressed spawns are observable (`echo_rejected=` in
  `list_claims()` / `[ledger]`). New `phase-native-ledger.ts` runs the real sandbox + handler
  chain and proves literal spawns run, duplicates coalesce, and C3 echo against a running
  ancestor survives. 28/28 smoke suites.

- **False `_StallTimeout` on a healthy long sub-call.** `refreshWatchdog()` now writes a
  `{type:"heartbeat"}` frame so the worker's stall alarm rearms while the host is still
  working. `await_task` returns `Error: sub-call still running` instead of aborting the
  cell with a traceback; the Task stays unsettled and a later `await_task` collects it.
  Headless `runRlm` now ticks the same watchdog interval as native repl (it previously
  had none, so a long child could SIGKILL the parent worker at `requestTimeoutMs`).

## [0.3.8] — 2026-08-16

Port of the rlm_test v5 engine (0.2.0 → 0.5.0 findings) plus the post-port audit fixes.
Five new subsystems, all on by default, each with a one-flip rollback in `rlm.json`.
26/26 smoke suites green.

### Added

- **Token budget cascade** (`core/budget.ts`) — the primary run-length control, replacing
  timeouts-as-content-limits. Cap = `budgetShare` (0.25) × the model's context window, clamped
  by `budgetTaskCap` (400k). At 80% of the cap the model gets exactly ONE wrap-up turn; at the
  cap the trajectory is distilled (`distillTrajectory` — goal, confirmed findings, REPL state,
  next step) and handed to a fresh continuation run, chain-capped at `budgetMaxContinuations`
  (2). A budget never throws: the v4 "finalize NOW" wrong-answer flaw is fixed by
  restructure-and-resume. Chain results report the whole chain's spend and persist under the
  ORIGINAL root key, so the next identical prompt replays. Wall-clock timeouts stay as hang
  backstops only (`maxTokens` documented as the separate hard-abort tree cap).
- **G1 head+tail elision** (`core/compaction.ts`) — old tool payloads elided with the working
  set tail kept, before the summarizer; often avoids summarization entirely (v3 measured
  −97% tokens on coding).
- **TaskLedger blackboard** (`core/ledger.ts`) — session-global claim state every agent sees
  (`[ledger]` block in prompts, silent when empty; `list_claims()` REPL call). Stops duplicate
  work three ways: exact-hash coalesce (one runner, many waiters), ancestor-echo reject (a child
  restating an ancestor task gets a stub), and near-dup coalesce (Jaccard ≥ 0.8, or ≥ 0.7 with
  the same paths). `rlmBudget` (8) demotes extra `rlm_query` spawns to `llm_query`. Every leaf
  (including each `llm_batch` item) and every child routes through it; `waitFor` is bounded so
  a dead runner parks nobody forever. Claims are immutable frozen records with the full
  pending → running → done/error lifecycle.
- **Durable memory** (`core/memory.ts`) under `<root>/.rlm/` — L1 episodes (JSONL, append-only,
  trim at 4k) with sha256 file-hash invalidation replay an identical read-only run for ZERO
  API calls (v5 measured 10,051 → 0 tok); L2 notes (single JSON) with BM25 retrieval,
  link-on-write, and batched A-MEM-lite consolidation (single-flight, verbatim fallback).
  Root episodes snapshot the real-file slice of the context for replay invalidation; hashing
  is chunked (64KiB `readSync`) and jailed to the workspace root (`../` gets no digest).
  The sandbox reaches it via `memory.query(q)` / `memory.add(text, paths=…, tags=…)` /
  `memory.stats()` — one implementation (`serviceOp`) shared by both composition roots.
  Writes are fail-soft; notes carry a never-store-secrets warning in both prompt surfaces.
- **Provider concurrency caps** — `providerMaxConcurrent` (e.g. `{ "zai": 4 }`) clamps the
  session gates against the RIGHT model per gate: leaf completions against the worker
  provider, recursive child engines against the smart provider (providers that break > 4
  concurrent agents are protected). Gates are built by one memoized resolver shared by BOTH
  composition roots and rebuild when `/rlm-config` changes providers. Status line shows active
  caps (`· caps zai=4`).
- **Delegation child surface** (`childSurface: "delegation"`) — v5 role separation: child
  engines get the closed delegation API (llm calls, spawn/await, map_files, memory/ledger)
  with NO `search`/`grep_context`/`outline`/`add_context`; their world arrives as text via
  the inherited context. The system prompt, worked examples, ENV tips, and orchestrator
  addendum all carry delegation variants so the prompt and the runtime sandbox agree.
  `"legacy"` restores today's full child surface.
- **Offline model context registry** (`core/model-registry.ts`) — metadata →
  `.rlm/models_cache.json` (24h TTL, fail-soft) → conservative table → 32k fallback.
- **Sandbox scaffold split** — `worker.py` (949 lines) split into protocol machinery +
  `scaffold.py` (the model-facing REPL API mixin); pure move, both well under the 1k rule.
- **New suites** — `test/budget.ts`, `test/ledger.ts`, `test/memory.ts`, `test/composition.ts`
  (the second-construction-path guard), `test/concurrency-provider.ts`, `test/child-surface.ts`.

### Fixed (post-port audit)

- **Both composition roots wired.** `RlmController.start()` (the `rlm` tool / native-mode
  path) now receives the session `MemoryStore` and the provider-capped session gates through
  one `buildEngine` seam — the same class of drift that caused issue #4 is now guarded by
  `test/composition.ts`.
- **One subcall node per `rlm_query`** (no ghost sibling left `running` forever); native
  `repl()` turns call `beginRun`/`endRun` on the session ledger, so ancestor-echo detects a
  child restating the user's cell.
- **Continuations carry the REPL working set** — `formatReplOutputs` emits the `REPL stdout:`
  needle `distillTrajectory` harvests (tested through the real formatter); findings join
  chronologically with the next-step hint still newest-first.
- **Root replay hygiene** — continuation chains persist under the original key; aborted and
  `LimitError` partials are never recorded.

### Changed

- `RlmConfig` +30 fields (all validated in `settings.ts`, frozen in `defaults.ts`):
  `enableTokenBudget`/`budgetShare`/`budgetSoftFrac`/`budgetTaskCap`/`budgetMaxContinuations`/
  `budgetHandoffChars`, `enableLedger`/`rlmBudget`, `enableMemory`/`injectNoteTokens`/
  `evolveEvery`/`memoryDir`, `providerMaxConcurrent`, `childSurface`. `memoryDir` relocates
  the store only; `enableMemory` is the on/off switch.
- `llm_query` leaves keep their `emitting()` node with the ledger routing wrapped around it.
- `FINALIZE_PROMPT` unified with the budget wrap-up dialect (answer-ready first).
- Native-mode prompt documents `memory.*`, `list_claims()`, and the secrets warning.

### Fixed

- **`rlm_query(task=…)` / `rlm_batch(tasks=[…])` TypeError.** The native-mode prompt
  docs advertise `task`/`tasks` as the kwarg names for recursive calls, but the Python
  scaffold (`worker.py`) only accepted `prompt`/`prompts` — every documented call raised
  `TypeError: unexpected keyword argument 'task'`, and because the exception fired before
  the assignment, the task variable never landed in the REPL namespace, cascading into
  `NameError`/`KeyError` ghosts in every later cell. Both spellings are now accepted
  (`task=`/`tasks=` canonical, `prompt=`/`prompts=` legacy, positional unchanged), and a
  bad call raises a self-describing `TypeError` whose message shows the correct call shape.
  `paths=` forwarding to the host handler is unaffected.

### Changed

- **Prompt docs state the dual signature explicitly.** `glossary.ts` and `native.ts` now
  document `rlm_query(task|prompt, …)` / `rlm_batch(tasks|prompts, …)` and add a REPL
  contract line: if a spawn call raises, the assignment did not run and the variable is
  undefined in later cells — re-spawn with the corrected signature from the error message.

### Added

- **`test/phase-scaffold.ts`** — regression suite for the scaffold signatures: all spellings
  spawn/await/return correctly, `paths` reaches the host handler, TypeErrors self-describe,
  and a doc-drift guard parses the prompt sources for every advertised `rlm_*` kwarg and
  fails if the worker scaffold does not accept it.

## [0.3.6] — 2026-08-13

### Fixed

- **Plugin cover image URL — canonical form.** The `pi.image` URL in `package.json` and
  the cover `<img>` in the plugin README now use the canonical GitHub URL
  `https://github.com/openzebra/rlm.pi/blob/master/assets/plugin-cover.png?raw=true`
  (resolved against `master`, the repository's default branch) instead of the
  `raw.githubusercontent.com` form.

## [0.3.5] — 2026-08-13

### Fixed

- **Plugin cover image on pi.dev.** The `pi.image` URL in `package.json` pointed at the
  `main` branch, but the repository's default branch is `master` — the raw GitHub URL
  404'd and pi.dev rendered no image. The URL now resolves against `master`, and the
  same broken `main` references in the root and plugin READMEs (cover `<img>`, video
  posters) were corrected. `assets/plugin-cover.png` now shows as the plugin image.

## [0.3.4] — 2026-08-11

### Added

- **`max` thinking level.** `reasoning: max` is now accepted by the settings validator
  (`settings.ts`) and exposed in the `/rlm-config` model picker. Previously a hand-edited
  `rlm.json` carrying `max` was silently dropped as an unknown level — only `off` remains
  excluded (it is not a ThinkingLevel).

### Changed

- **pi-ai 0.84.1 compatibility.** `completeSimple` and the completion types now import from
  `@earendil-works/pi-ai/compat` instead of the package root — the root re-export of these
  symbols was removed upstream. Requires the 0.84.x peer line.
- **Test migration to the 0.84.x `ModelRegistry` constructor.** The deprecated
  `ModelRegistry.create(AuthStorage.create())` helper is gone; tests now share a
  `MOCK_REGISTRY` (`helpers.ts`) that supplies `getAvailable`/`getAll` for wiring.

### Fixed

- **Worker leak when `dispose()` races an in-flight spawn.** If `SandboxManager.dispose()`
  fired while a Python worker was still spawning, the freshly-resolved process was never
  killed — it leaked. `dispose()` now awaits the pending `initPromise`, and the spawn guard
  disposes the worker the instant it resolves, so no process survives teardown.
- **Worker leak on failed context load.** If `loadContext` threw during first spawn, the
  spawned worker was abandoned without disposal. It is now disposed and the `initPromise`
  is cleared, so the next call can retry cleanly.

### Docs

- **READMEs rewritten** (root, `pi-plugin/rlm`): added benchmark tables, supported document
  formats, and a "Why pi-rlm?" section; new plugin cover image.

## [0.3.3] — 2025-08-10

### Fixed

- **Pin wipe on toggle / config save.** `setEnabled()` and config-panel saves could write
  `rlm.json` without the `llm` key if they fired before persisted settings loaded, silently
  reverting to "cheapest" on the next session. `saveSettings` now merges the existing disk
  `llm` when the caller provides no explicit pin, so config-only saves never strip it.
- **Stale pin across sessions.** Settings were loaded once at extension boot; a pin set
  during one session was invisible to the next session inside the same Pi process.
  `session_start` now re-reads `rlm.json` from disk every session.
- **No signal for explicit cheapest clear.** The pin-clear path (user picks "cheapest") was
  indistinguishable from "not loaded yet", so a merge-only fix would also preserve a pin the
  user wanted to remove. A new `explicitClearPin` flag on `RlmController` disambiguates:
  explicit clear writes `null` (omit `llm` from disk), while no-op writes `undefined`
  (trigger merge).
- **Removed tmp+rename atomic writes.** Direct `writeFile` now. Simpler, no `.tmp` litter,
  and the merge guards against partial writes — a zero-byte file is still a valid `{}`.

## [0.3.2] — 2025-08-10

### Added

- **Atomic writes for rlm.json.** Settings are now written to a `.tmp` file then renamed —
  if Pi crashes mid-write, the previous config survives instead of being truncated.
- **Immediate model-choice persistence.** When you pick a sub-LLM model in
  `/rlm-config`, the choice is saved to disk BEFORE the config panel opens — if the
  panel fails or Pi exits before you close it, the model pin survives.
- **Model picker no longer defaults to "cheapest" when the pinned model is absent.**
  If your saved model is temporarily unavailable (e.g. API key not loaded yet),
  the picker pre-selects the first real model instead of "cheapest auto" —
  accidental Enter won't wipe the pin.
- **Thinking/CoT guidance in native prompt.** A `THINKING RULE` section tells the model
  when to plan out loud (complex decomposition, uncertainty) vs. jump to `repl()` (simple
  lookups, known paths). Prevents premature repl() calls on uncertain targets.
- **Depth visibility for child RLMs.** Sub-RLMs now see `Recursion depth: N` in their
  system prompt with scoped ambition instructions — delegate only if the task itself must
  decompose further.
- **"NOT for" column in the Always-spawn tool table.** Each tool now has negative guidance
  (e.g., `llm_query` — NOT for reading files; `rlm_batch` — NOT for trivia/one-shots).
- **Context read-only contract.** Children are explicitly sandboxed: they cannot mutate
  the parent's `answers`, `plan`, or REPL variables. Only the return string survives.
- **answer["ready"] finalization nudge.** An explicit "You MUST flip" directive reinforces
  the answer contract — runs that never finalize are discarded.

### Changed

- **Root tasks wrapped in `<task>` XML tags** instead of `Answer the following:` prefix.
  Cleanly separates user intent from system instructions (Anthropic Ch 04 pattern).
- **Anti-pattern examples (E4–E7) now include WHY each fails** — consequence lines explain
  the silent failure mode (e.g., "→ You'll read a Task repr, not the data. Silent garbage.").
- **Native prompt budget remains at 9,500 chars** after all additions (currently 8,563).

### Fixed

- **native-smoke.ts assertion strings** updated for the api_v5 prompt restructure:
  `"REPL Environment"` → `"REPL surface"`, `"Choosing Between Tools"` → `"Always-spawn fan-out"`,
  `"Worked pattern"` → `"E1 multi-area study"`, `"Decomposition doctrine"` → `"LOCATE-THEN-DELEGATE"`.

## [Unreleased]

### Added

- **Always-spawn fan-out (breaking).** `llm_query` / `llm_batch` / `rlm_query` /
  `rlm_batch` / **`map_files` / `llm_query_chunked`** always return a Python `Task` —
  never auto-await. Collect with `await_task(t)`. Only `llm_map_reduce` still blocks
  (map then reduce). Fire independent Tasks, do free `search`/`grep`, then await once.
- **Always-detached sub-LLM posts.** Bare `llm_batch` / `map_files` (not only
  `spawn(...)`) post `detached=true` → host BG registry, **↯bg** marker, work outlives
  the `repl()` cell. Fixes “looks serial / no BG” when agents call `map_files(...)`.
- **Search/grep hit shape unified.** Both expose `snippet` and `text` keys (aliases) to
  prevent `KeyError: 'snippet'` when agents mix the two APIs.


- **api_v5 async-by-default subcall surface.** Canonical tools only:
  `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` + `await_task` (Python; bare `await`
  is a keyword) / `finish`. Host handlers live under `bridge/handlers/` (`completion`,
  `emitting`, `task-registry`, `llm-query`, `rlm-query`, `await`, `finish`, assembly in
  `index.ts`). Wire protocol kinds match worker + `interrupts.ts` (no legacy
  `*_query_batched` names).
- **Context refresh after native `edit`/`write`.** Disk mutations re-read into
  `contextPayload` and the live worker REPL `context` so `search` / `grep_context` /
  `map_files` / sub-LLMs no longer see pre-edit file bodies. See `context/refresh.ts` and
  `SandboxManager.refreshFileFromDisk`.
- **Unawaited-task runtime reminders** in the headless engine: between turns, if the run’s
  task registry still has pending ids, inject
  `[runtime] Unawaited task_ids: … — call await before finish.`
- **Tests:** `phase-context-refresh.ts`, `phase-finish-warn.ts`; smoke harness updated.
  Batch-gate / phase4 / async suites updated for SpawnResult + `awaitTask`.

### Changed

- **Native/headless prompts → api_v5 style (rlm_test bake-off winner).** Front-loaded
  `<contract>` / `<routing>` / few-shots: multi-area work prefers `rlm_batch` /
  `rlm_query` as always-spawn Tasks (fire → free locate → `await_task`), not serial
  `repl` + native `read`. `repl` tool description and per-turn reminder match.
  Explicit ban: path-only `llm_query("Read src/foo.ts…")` (no disk); use `map_files` /
  `rlm_*` which attach `context`.
- **Removed hard-blocks on native `read` / `grep` and bash readers.** Soft stdout caps remain
  (`tool_result` for bash/find/ls/read/grep). Prompts no longer mention allow/deny of native
  readers — prefer `repl` for bulk, tools stay available.
- **Canonical batch names (breaking for model-facing REPL).** `llm_query_batched` →
  `llm_batch`, `rlm_query_batched` → `rlm_batch`. No aliases. Collect with `await_task(Task)`
  or `await_task([…])`.
- **Leaf concurrency:** `complete1` takes `gates.leaf` once per completion; batches do not
  double-acquire (deadlock fix retained). `childRun` uses per-depth `gates.rlm`.
- **`finish` soft policy:** always succeeds; if pending tasks remain, returns `warning` listing
  unawaited ids (does not auto-drain into the summary).
- **No per-call model override on REPL sub-calls.** Leaf completions use the configured RLM LLM
  only (`/rlm-config` / `rlm.json` pin, else cheapest). Recursive children inherit the parent
  root model.
- Deleted monolithic `bridge/subcall-handlers.ts` in favor of `bridge/handlers/` (single import
  path).

### Fixed

- **Sub-LLM pin no longer resets to cheapest on every `/rlm-config`.** The model
  picker always opened on "⟳ cheapest (auto)" and never pre-selected the current
  pin, so Enter while reopening config silently cleared `rlm.json` `llm`. Now the
  list starts on the pinned model (or saved ref); choosing cheapest no longer
  wipes `subSampling.reasoning`; unresolved pins warn once and stay on disk.
- **Host↔worker batch wire replies.** Interrupt layer maps handler returns to
  `{ response }` / `{ responses: string[] }` (and unwraps SpawnResult via `awaitTask`) so the
  worker reducers no longer see `malformed batched response` / double-quoted strings.
- **Windows/cp1252 sandbox transport (issue
  [#7](https://github.com/openzebra/rlm.pi/issues/7), thanks [@eglove](https://github.com/eglove)).**
  Node always speaks UTF-8 on the host↔worker pipe and in context temp files, but Python text
  I/O defaults to the locale encoding — cp1252 on a Western Windows install — so any non-ASCII
  content raised `UnicodeDecodeError` in `load_context` / `add_context` before the REPL ran, and
  REPL output with Cyrillic/CJK/emoji killed the worker mid-request via `UnicodeEncodeError` on
  stdout. Fix is three layers: new `py/hostio.py` with `read_host_payload` (strict UTF-8) and
  `pin_stdio_utf8()` (`.reconfigure()` so it beats `PYTHONIOENCODING`), both scaffold reads
  collapsed onto that helper (DRY), and `-X utf8=1` on the worker spawn so model-written bare
  `open()` is UTF-8 too. Declined `errors="replace"` on the read side — the host always writes
  UTF-8, so a decode error is a transport bug and replacing would feed the model mojibake'd
  source. Also sets `windowsHide: true` on the worker spawn (matches pi) so each sandbox does
  not flash a console window on Windows.

### Removed

- Legacy model-facing names: `llm_query_batched`, `rlm_query_batched`, `rlm_await` /
  `rlm_await_all` (use `await_task`), and the old hard-block native-reader policy.

## [0.3.0] - 2026-08-10

### Changed

- **Replaced `repomix` with a native walker + `@firecrawl/anydoc`.** Context packing no longer
  pulls 28 transitive dependencies for gitignore + binary filtering. A native
  `git ls-files -co --exclude-standard -z` (with `walkFs` fallback) enumerates the tree;
  documents (PDF, DOCX, XLSX, PPTX, CSV, …) convert to Markdown via anydoc and cache under
  `$XDG_CACHE_HOME/pi-rlm/anydoc` (else `~/.cache/…`) keyed by pre-conversion `(size, mtimeMs)`.
  Requires **Node ≥ 20** (NAPI native addon).
- **`load_library` → `add_context` (breaking).** Same control flow; namespaces move from
  `lib/<id>/` to `ctx/<id>/`. No alias — the prompt is the only teacher of the name. Return
  metadata gains `documents` (docs in payload, including cache hits) and `converted` (fresh
  conversions this call), plus a capped `skipped` list.
- **`context` starts empty (breaking).** The working directory seeds lazily on the first
  `repl()` call (`autoSeedCwd: true`, un-prefixed paths so `search()` hits remain real paths for
  `edit`/`write`). Config renames `libraryLoader` → `contextLoader` (legacy key still read from
  `rlm.json`). The compact listing injects only when the payload identity changes, not every
  turn.
- **Removed `repomix` dependency**; added `@firecrawl/anydoc@^0.1.7`.

### Added

- **Document conversion** for binary containers that repomix dropped as opaque assets (PDF,
  DOCX, XLSX, PPTX, CSV, Office macro variants, …). Lazy NAPI load — missing platforms degrade
  to `skipped: "no-converter"` without crashing plugin load.
- **`autoSeedCwd` config toggle** in `/rlm-config` (default on).
- **`SkipReason` closed union** for model-facing skips (`binary`, `sensitive`, `symlink-escape`,
  anydoc codes, …) instead of free-form strings.

### Fixed / security

- **Secrets no longer enter context.** A deny-list under `.gitignore` drops `.env*`, key
  material (`id_rsa*`, `*.pem`/`*.key`/`*.p12`, …), and paths under `.ssh`/`.aws`/… as
  `skipped: "sensitive"`. `walkFs` does not descend into dot-directories except `.github`.
  Single-file `add_context` of a secret path hard-refuses.
- **Symlink escape closed.** `lstat` + `realpath` refuse targets outside the packed root
  (`symlink-escape`) and re-check sensitivity on the resolved path — an innocuous link name
  pointing at `/tmp/prod.env` no longer leaks.
- **`add_context(".")` no longer doubles the tree.** The cwd seed registers a host sentinel
  (`""` + absolute path); re-adding cwd is `alreadyLoaded`. Subpaths of the seed short-circuit
  only when those un-prefixed files are already in context (gitignored subtrees still pack).
  Failed seed is sticky (no re-walk storm) and `add_context(".")` recovers un-prefixed.
- **MD cache no longer freezes stale Markdown.** Stamp is captured before conversion; write
  refuses if a post-conversion stat disagrees. Cache hits report `converted: 0` but
  `documents: N`.
- **Document size cap** `MAX_DOCUMENT_BYTES` (64MB) during directory walks; skipped list capped
  at 64 entries on the wire. Shallow clone sets `GIT_TERMINAL_PROMPT=0` so private URLs fail
  fast instead of hanging on a credential helper.

## [0.2.2] - 2026-08-09

### Removed

- **`/rlm-resume`, `/rlm-runs`, `/rlm-help`.** Resume existed for a headless engine root the
  plugin no longer routes to, and `/rlm-help` duplicated the guide already posted at
  `session_start`. `/rlm`, `/rlm-stop` and `/rlm-config` remain.
- **The phase pipeline** (`clarify → research → blueprint → validate`), which shipped
  `pipeline: false` and was never turned on. With it go `core/pipeline*.ts`, `core/gates.ts`,
  `core/critique.ts`, `prompts/phases.ts`, the `save_artifact` / `advance_phase` sandbox
  functions, and the `--read-only` worker mode that only existed to keep a plan run from
  writing files.
- **`core/artifacts.ts` / `save_artifact`.** Only ever reachable from the pipeline.
- **`todo()`.** It was a per-session in-memory list wired to nothing outside the plugin — a
  wrapper for a job that belongs to the main agent and its own tools, not to the RLM sandbox.
  Following prime-agent: do not re-add non-native wrappers.
- **The run trail, `.pkl` snapshots and `runLog` config** (`src/state/**`, `sandbox.snapshot` /
  `restore`, the worker's snapshot RPC). With resume and `/rlm-runs` gone nothing in the tree
  read any of it, so every run was paying for write-only disk I/O. **The engine now performs no
  disk I/O at all.**
- **`ask_user_question` / `askUserQuestion` config.** The clarify pipeline was the only real
  consumer; the REPL helper, bridge, protocol interrupt, config toggle, and prompts are gone.
- **USD budget ceiling (`maxBudgetUsd`).** Config, UI, `LimitGuard` enforcement, and remaining-
  budget propagation on recursive children are removed. Cost is still tracked for display;
  wall-clock / token / consecutive-error caps remain.

### Fixed

- **"Cheapest LLM model" could not see a free model.** Pi's `ModelCost` is non-nullable, so
  free is a literal `0` — but many catalog entries (subscription and token-plan providers,
  anything composed with default costs) are also `0`, and `[...models].sort()[0]` is stable, so
  the pick was simply whichever zero-cost model came first in catalog order. Ranking now lives in
  `mode/llm-model.ts`: free first, then widest context window (a free 4K model is useless as a
  bulk reader), then `maxTokens`, then `provider/id` so the choice is stable across sessions and
  catalog reorderings. Pricing is weighted 3:1 toward input, matching what a sub-call actually
  sends. Selection is a single pass — no array copy, no sort allocation.
- **`/rlm-config` silently ended "cheapest (auto)".** Pressing ESC at the model picker fell into
  the branch that resolves cheapest *once* and writes it to `~/.pi/agent/rlm.json`, after which
  the auto pick was never consulted again — including once a cheaper model appeared. Only an
  explicit choice now touches the pin, and the confirmation names the model that actually
  resolved instead of printing `(cheapest)`.
- **LLM-model selection could run against an empty catalog.** `session_start` (and
  `/rlm-config`) now await `modelRegistry.refresh()` before reading `getAvailable()`, which
  newer pi builds populate asynchronously. Fail-soft: a refresh error is logged, never fatal.
- **`/rlm-config` dumped the entire model catalog.** The picker used `getAll()`, so every
  provider's catalog entry appeared — far more than Pi's own model list. It now mirrors Pi:
  session `scopedModels` when set, otherwise `getAvailable()` (auth-configured providers only).
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
  That number is what the model is told to size its batches against.
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
- **`maxConcurrentChildren`** — child engines bounded separately from leaf sub-calls. Each child
  is a Python subprocess holding its own copy of the inherited context.
- Context files are serialized once per payload version and shared by refcount across every
  child that inherits it, in bounded chunks so a large repository never blocks the event loop.

### Changed

- **Default concurrency:** `maxConcurrentSubcalls` **16**, `maxConcurrentChildren` **6**
  (was 6 and 3).
- **`worker` → `llm` naming** for the sub-LLM pin (`mode/llm-model.ts`, settings key `llm` with
  legacy `worker` still read on load).
- Files split so none carries two jobs: `sandbox/worker.py` → `sandbox/py/{worker,guards,
  retrieval,tasks}.py`; `prompts/system.ts` → `glossary` + `system` + `native`;
  `tool/repl-tool.ts` → `repl-result` + `repl-render` + the tool; `sandbox/sandbox.ts` →
  transport + `sandbox/interrupts.ts`.
- **Cost profile of `rlm_query`.** A child that used to see a 2 KB prompt now sees the whole
  repository and has `maxIterations` turns to spend on it, so a fan-out of N children is N real
  repository analyses. Remaining wall-clock timeout still propagates down the tree.

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

[Unreleased]: https://github.com/openzebra/rlm.pi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.3.0
[0.2.2]: https://github.com/openzebra/rlm.pi/releases/tag/v0.2.2
[0.2.1]: https://github.com/openzebra/rlm.pi/releases/tag/v0.2.1
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
