# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.0
