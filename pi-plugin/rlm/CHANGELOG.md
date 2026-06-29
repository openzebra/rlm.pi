# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-29

Initial release of `@openzebra/pi-rlm`, a native Recursive Language Model (RLM) extension
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
- Optional MLflow tracing (`telemetry`) for run correlation.
- Code-edit collection surfaced as a review popup (with a `yolo` mode to apply immediately).
- `/rlm-config` settings: smart/worker model selection, max recursion depth, iteration cap,
  budget ceiling, max consecutive errors, per-REPL-block timeout, max concurrent sub-calls,
  trajectory compaction, and toggles for `ask_user_question` and `todo`.

[0.1.0]: https://github.com/openzebra/rlm.pi/releases/tag/v0.1.0
