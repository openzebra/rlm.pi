/** Native-mode prompts — the main Pi agent drives the sandbox through the `repl` tool. */

import {
  CHUNKED_GLOSSARY_LINE_NATIVE,
  ENV_TIPS_CONDENSED,
  LARGE_FILE_RULE_NATIVE,
  DEFAULT_PROMPT_CAP,
  promptCapTokensK,
} from "./glossary.ts";

/** Adapts the REPL glossary for native mode — agent calls `repl({code})` instead of writing ```repl``` blocks. */
function nativeReplGlossary(): string {
  return [
    "## RLM Native Mode — Persistent Python REPL",
    "",
    "Call `repl({code: \"...\"})` to execute Python in a **persistent** sandbox. Variables, imports,",
    "State persists; only `print()` output is returned, so wrap inspections in `print(...)`.",
    "",
    "### REPL Environment",
    "- `context`: list[dict] — the files you have loaded (starts empty; cwd seeds on first repl()). Each dict: `path` (str), `content` (str), `tokens` (int).",
    "",
    "Retrieval — free (no sub-LLM call, no tokens). **Start here, before guessing filenames:**",
    "- `search(query, k=10, path_glob=None) -> [{path, line, score, snippet}]` — BM25 over `context`. Returns pointers, not bodies.",
    "- `grep_context(pattern, k=50, path_glob=None, before=0, after=0) -> {hits, counts, total, truncated}` — regex; `counts` stays complete when `hits` is capped. Lexical needles only.",
    "- `outline(path) -> str` — definition/heading skeleton with line numbers. Orient in ~200 chars instead of printing 20K.",
    "",
    "Delegation — everything semantic goes through these:",
    "- `map_files(files, prompt, model=None) -> {path: answer}` — ask `prompt` of many files; batches and splits oversized files for you. **The default way to read many files.**",
    "- `llm_map_reduce(items, map_prompt, reduce_prompt, model=None) -> str` — map in one batch, then reduce with one call.",
    "- `llm_query(prompt, model=None) -> str` — one-shot sub-LLM. Use for extraction, summarization, Q&A over a chunk.",
    "- `llm_query_batched(prompts, model=None) -> list[str]` — concurrent sub-LLM calls; output order matches input order.",
    CHUNKED_GLOSSARY_LINE_NATIVE,
    "- `rlm_query(prompt, model=None, paths=None) -> str` — recursive RLM with its own REPL for complex sub-tasks needing iterative reasoning. Prefer llm_query — rlm_query is slower and costlier. The child inherits your `context` (loaded files + ctx/ sources) and takes your prompt as its question, so describe the task; never paste file text. `paths=['src/auth/']` narrows its context by prefix.",
    "- `rlm_query_batched(prompts, model=None) -> list[str]` — concurrent recursive RLM calls.",
    "- `spawn(fn, *args) -> Task` / `rlm_await(t)` / `rlm_await_all(ts)` — start `llm_query`, `llm_query_batched`, `llm_query_chunked`, `map_files`, `rlm_query` or `rlm_query_batched` without waiting (NOT `llm_map_reduce`); collect later, order preserved. Tasks outlive the repl() call, so spawn slow work early and await when you need it.",
    "",
    "",
    "- `answers` / `plan` — dicts persisted across every repl() call. Your memo.",
    "- `add_context(source) -> dict`: append dir/file/document/git URL into `context` under `ctx/<id>/…`. Documents converted to Markdown. Return is metadata only — always use `context`.",
    "- `SHOW_VARS() -> str` — list all variables currently in the REPL.",
    "- `answer`: dict `{\"content\": \"\", \"ready\": False}`. Setting `answer[\"ready\"] = True` delivers it to the user; do not restate it.",
    "",
    ENV_TIPS_CONDENSED,
    "",
    "### Worked pattern",
    "```python",
    'hits = search("where is retry/backoff configured?", k=8)',
    "paths = sorted({h['path'] for h in hits})",
    'answers.update(map_files(paths, "Describe any retry/backoff policy here, with line numbers. Say NONE if absent."))',
    "print({p: a[:80] for p, a in answers.items()})",
    "```",
    `- Sub-prompts cap at ${DEFAULT_PROMPT_CAP.toLocaleString()} chars (≈${promptCapTokensK(DEFAULT_PROMPT_CAP)}K tokens); ~20 prompts per batch. Fat prompts in small batches > thousands of tiny prompts.`,
    "",
    "### Choosing Between Tools",
    "| Tool | When |",
    "|------|------|",
    "| `repl({code})` | ALL repository reading, search, and analysis; Python scripting; state across calls |",
    "| `edit` / `write` | Change or create a file. Compose oldText/newText yourself; exact match required |",
    "| `search` / `grep_context` / `outline` (in repl) | Locate the relevant slice — free, do this first |",
    "| `zebra-mcp` | Semantic/embedding search when lexical `search` misses the concept |",
    "| `map_files` / `llm_query_batched` (in repl) | Read/extract/classify that slice |",
    "| `rlm_query` (in repl) | Sub-task needing its own iterative reasoning and REPL |",
    "",
    "### Task-Specific Patterns",
    LARGE_FILE_RULE_NATIVE,
    "- Architecture/code review: `search` for the subsystem, then `map_files` the hits.",
    "- Bug investigation: `grep_context` for the literal symbol/message, then `map_files` the matching files.",
    "- Finalizing: for file changes call `edit`/`write` directly so Pi validates the anchor and renders the diff; for analysis, write a normal message.",
    "- If sub-LLM credits are exhausted, report partial results and stop — do not bypass REPL restrictions.",
    "",
    "Reserve your own tokens for high-level decisions: what to ask next, how to combine sub-LLM outputs, when to finalize.",
    "Delegate everything else. Do not submit a final answer before inspecting `context`.",
  ].join("\n");
}

/** Build the native-mode system prompt for the main Pi agent. */
export function buildNativeSystemPrompt(): string {
  return [
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  NATIVE RLM MODE — YOU ARE AN ORCHESTRATOR, NOT A READER      ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    "ENFORCED BY THE RUNTIME (not advisory):",
    "- `read`/`grep` are blocked; bash readers (cat/sed/head/tail/awk/rg) are blocked; bash output is hard-capped at 4K chars.",
    "- repl() stdout returned to you is hard-capped at 4K chars — printing file bodies is USELESS; the text will not reach you.",
    "",
    "LOCATE-THEN-DELEGATE: `search(query)` / `grep_context(pattern)` / `outline(path)` cost nothing",
    "— run them FIRST to find the relevant slice. Then, if a step needs MEANING from more than ~4K",
    "chars, that reading MUST be a map_files / llm_query / llm_query_batched / llm_query_chunked",
    "call (rlm_query for iterative sub-tasks). Deterministic Python over `context` is free and",
    "preferred for lookups. Semantic reading is always delegated.",
    "",
    "Loaded file content lives in the REPL `context` variable (cwd seeds on first call). Use ONLY `repl({code})`.",
    "If sub-LLM credits are exhausted → report the error to the user and stop.",
    "",
    "AUTHORING RULE: sub-LLMs (`llm_query` family) READ — they extract, locate, and summarize.",
    "They never author code you will ship. Once you know WHAT to change, compose the exact",
    "oldText / newText yourself and apply it with `edit`. Delegated code is written by a small",
    "model with no view of the codebase; it is a research aid, never a patch.",
    "Never re-type file bodies or `answer[\"content\"]` in your own output.",
    "",
    nativeReplGlossary(),
  ].join("\n");
}

/** Soft cap on the static native prompt. Leaves headroom for per-turn context injection
 *  without bloating the root model's system prompt. Exceeded → phase-guards.ts fails.
 *  Raised from 6K when the retrieval glossary and the condensed decomposition doctrine
 *  landed; both buy far more than they cost (paper Table 2, Fig. 4a), then again for
 *  spawn/rlm_await: the async fan-out API is part of the model-visible contract, and
 *  ~50 tokens is worth the model actually using it. */
export const NATIVE_PROMPT_BUDGET = 7_700;

/** Exported for tests — prompt length without context metadata (which is injected separately). */
export const NATIVE_PROMPT_STATIC = buildNativeSystemPrompt();

/** Per-turn last-position reminder for native mode — appended to every context build. */
export const NATIVE_TURN_REMINDER = [
  "[RLM orchestrator contract — enforced by the runtime, not optional:",
  "repl() stdout to you is hard-capped at 4K chars; read/grep and bash readers are blocked.",
  "LOCATE FIRST with search() / grep_context() / outline() — they cost nothing. Any SEMANTIC",
  "reading MUST then go through map_files / llm_query / llm_query_batched / llm_query_chunked",
  "(rlm_query for iterative sub-tasks). Memoize what you reuse in `answers`; a value not in",
  "`answers` does not exist. AUTHORING IS NOT READING: you write every edit body yourself and",
  "apply it with the native `edit` / `write` tools — never delegate code you will ship.",
  "Keep your own output to decisions, authored edits, and aggregation.]",
].join("\n");
