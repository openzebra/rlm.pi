# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  to `"*"`, matching the rpiv package convention.
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

[0.1.1]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.1
[0.1.2]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.2
[0.1.3]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.3
[0.1.4]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.4
[0.1.5]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.5

[0.1.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.0
