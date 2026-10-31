/** Native-mode prompts — the main Pi agent drives the sandbox through the `repl` tool.
 *
 * Structure mirrors api_v5_anthropic (best bake-off arm): role → contract → routing →
 * few-shots → anti-patterns → REPL surface. Goal: multi-area work fires rlm_batch / rlm_query
 * as Task (BG), not serial repl+native read.
 */

import {
  ARCHIVE_RECALL_LINE_NATIVE,
  CHUNKED_GLOSSARY_LINE_NATIVE,
  CTX_VIRTUAL_PATH_NOTE,
  ENV_TIPS_CONDENSED,
  LARGE_FILE_RULE_NATIVE,
  DEFAULT_PROMPT_CAP,
  promptCapTokensK,
  SKILL_SEARCH_LINE_NATIVE,
} from "./glossary.ts";
import { STATE_FENCE_INSTRUCTION } from "../core/run-state.ts";

/** Adapts the REPL glossary for native mode — agent calls `repl({code})` instead of writing ```repl``` blocks. */
function nativeReplGlossary(): string {
  return [
    "## REPL surface (inside `repl({code})` only)",
    "Persistent Python sandbox (`context`: `list[dict]` with `path`, `content`, `tokens`). `print(...)` and trailing bare expressions return; vars/`answers`/`plan` persist.",
    CTX_VIRTUAL_PATH_NOTE,
    "",
    "### Free locate (no sub-LLM tokens)",
    "- `search(query, k=10, path_glob=None) -> [{path, line, score, snippet, text}]` — BM25 pointers",
    "- `grep_context(pattern, k=50, …) -> {hits, counts, total, truncated}` — regex needles",
    "- `outline(path) -> str` — definition skeleton (~200 chars)",
    ARCHIVE_RECALL_LINE_NATIVE,
    "",
    "### Always-spawn fan-out (return Task + run ↯bg — NEVER the answer)",
    "- `llm_query(prompt)` / `llm_batch(prompts)` → non-thinking leaf extractors (`str` / `list[str]`; embed text in prompt — no disk/context).",
    "- `map_files(files, prompt)` → `dict[path, str]` over `context` files.",
    CHUNKED_GLOSSARY_LINE_NATIVE,
    "- `rlm_query(task, paths=None)` / `rlm_batch(tasks, paths=None)` → thinking sub-RLM(s); child inherits your `context` (narrow with `paths=['src/auth/']`; never paste file bodies; sandboxed — cannot mutate your `answers`/`plan`).",
    "- Collect: `await_task(t)` / `await_task([…])` / `await_task()`. `spawn(fn, *args) -> Task` aliases spawn tools (not blocking `llm_map_reduce`).",
    "",
    "### Memo / state",
    "- `answers` / `plan` — persistent dicts for collected results (`SHOW_VARS()`, `list_tasks()`, `list_claims()`). `answer[\"ready\"]=True` is headless-only.",
    "- `add_context(source) -> dict` — append external dir/file/doc/git under `ctx/<id>/…`.",
    SKILL_SEARCH_LINE_NATIVE,
    "",
    ENV_TIPS_CONDENSED,
    `- Sub-prompts cap ${DEFAULT_PROMPT_CAP.toLocaleString()} chars (≈${promptCapTokensK(DEFAULT_PROMPT_CAP)}K tok); ~20 prompts/batch.`,
    LARGE_FILE_RULE_NATIVE,
    "- Outside REPL: `repl({code})` for repo locate/fan-out; `edit`/`write` for changes you authored; `zebra-mcp` for semantic search; native `read`/`grep` only for tiny edit anchors.",
  ].join("\n");
}

/**
 * omp/pi coexistence: appended when the host exposes a subagent tool named `task` so the
 * native routing does not neutralize the host's delegation heuristics. repl()-fan-out stays
 * the parallel-reading path; "Task" in the REPL sections below means a fan-out handle, not
 * the host's tool. Single wording source — not duplicated in the glossary.
 */
export const NATIVE_SUBAGENT_COEXISTENCE: readonly string[] = Object.freeze([
  "<subagent-coexistence>",
  "If the host provides a subagent tool named `task`, use it for multi-step autonomous research",
  "and delegation, following the host's own delegation rules (it runs in its own context window).",
  "repl()-fan-out (`llm_batch` / `rlm_batch` / `map_files`) remains the parallel READING path",
  "inside your own context. The word `Task` in the REPL sections below means the handle of a",
  "fan-out call, never the host's `task` tool.",
  "</subagent-coexistence>",
]);

/** Build the native-mode system prompt for the main Pi agent.
 *
 *  R1 (G1, /tmp/ROOT_FULL_SKILLSTATE_PLAN.md): `stateFences` appends the ONE Σ fence contract
 *  (STATE_FENCE_INSTRUCTION verbatim — one wording source, engine and native share it) so the
 *  native model can author ΔΣ_t through ```state fences. The fence text is STATIC, so it may
 *  ride call-time composition; the FLAG decision happens at the call site — NATIVE_PROMPT_STATIC
 *  (the frozen module-load snapshot) is composed with no options and stays contract-free.
 *  omp-compat: `hostSubagentTool` appends NATIVE_SUBAGENT_COEXISTENCE (see that constant).
 */

export function buildNativeSystemPrompt(
  opts?: { readonly stateFences?: boolean; hostSubagentTool?: boolean },
): string {
  return [
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  NATIVE RLM MODE — YOU ARE AN ORCHESTRATOR, NOT A READER      ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    "Multi-area repo work goes through REPL fan-out. Tool/repl outputs are hard-capped (~4K chars).",
    "AUTHORING RULE: sub-LLMs (`llm_query` / `rlm_query`) READ only — YOU compose exact oldText/newText and apply with `edit` / `write`.",
    ...(opts?.hostSubagentTool === true ? ["", ...NATIVE_SUBAGENT_COEXISTENCE] : []),
    "",
    "<contract>",
    "Inside `repl({code})`, heavy calls (`llm_query`, `llm_batch`, `map_files`, `llm_query_chunked`, `rlm_query`, `rlm_batch`) return a `Task` (↯bg), never the answer.",
    "Collect with `await_task(t)` / `await_task([…])` / `await_task()`. If `await_task` returns `Error: sub-call still running`, call it again — do not respawn.",
    "Fire independent Tasks first → free `search`/`grep_context`/`outline` → then `await_task`.",
    "</contract>",
    "",
    "<routing>",
    "- Text already in prompt → `llm_query` / `llm_batch` (non-thinking extractors; NO disk/context — never pass bare paths).",
    "- Same question over `context` files → `map_files(paths, prompt)`.",
    "- Multi-step study → `rlm_query(task=…, paths=…)`; ≥2 independent areas → `rlm_batch(tasks=[…])`.",
    "</routing>",
    "",
    "<examples>",
    "E1 multi-area study:",
    "```python",
    't = rlm_batch(["Study src/commands/ — NO edits.", "Study src/mode/ — NO edits."])',
    'hits = search("setEnabled OR toggle", k=8)',
    'answers["study"] = await_task(t)',
    "```",
    "E2 same question across files (`map_files`):",
    "```python",
    'hits = search("retry OR backoff", k=8)',
    't = map_files(sorted({h["path"] for h in hits}), "Retry policy + lines; NONE if absent.")',
    "answers.update(await_task(t))",
    "```",
    "E3 targeted leaf extracts (`llm_batch`):",
    "```python",
    'slice = [f for f in context if f["path"].startswith("src/bridge/")][:6]',
    't = llm_batch([f"Summarize exported symbols:\\n\\n{f[\'content\'][:4000]}" for f in slice])',
    'answers["bridge"] = dict(zip([f["path"] for f in slice], await_task(t)))',
    "```",
    "</examples>",
    "",
    "<rules>",
    "1. LOCATE-THEN-DELEGATE: free search/grep/outline first; semantic reading via Task tools; audit subtle counts yourself.",
    "2. AUTHORING: sub-LLMs READ only; you write every `edit`/`write`.",
    "3. Memoize into `answers`; prefer one `rlm_batch` over serial `rlm_query`.",
    "</rules>",
    nativeReplGlossary(),
    ...(opts?.stateFences === true
      ? [
          "",
          STATE_FENCE_INSTRUCTION,
          // Soak-B finding (R3): models ignore the contract when it only speaks headless
          // \u201c```repl block(s)\u201d \u2014 in native mode those are repl({code}) TOOL calls. The engine
          // wording above stays byte-identical (one source); this line maps it 1:1 onto the
          // native tool-call loop so the fence obligation is unambiguous.
          "NATIVE MODE: you emit repl({code}) as TOOL calls, not ```repl text blocks \u2014 the " +
            "contract above maps 1:1 onto this loop. In ANY reply where you learned something " +
            "durable (a path, a fact, a failed approach, the next step), ALSO emit a ```state " +
            'fenced block in that same reply: {"state_patch": {"verifiedFacts[+]": ' +
            '"src/x.ts \u2014 what you just verified"}}. Deltas only; one small patch per turn; ' +
            "never restate unchanged keys.",
        ]
      : []),
  ].join("\n");
}

/** Soft cap on the static native prompt. Raised for v5-style contract/routing/examples;
 *  recall W3 raised it again (+200) for the archive-recall + skill_search twin lines —
 *  the model cannot recall elided turns or prior-session facts it is never told about.
 *  +100 for the auto-echo sentence and the ctx/ virtual-path note (both prompts). */
export const NATIVE_PROMPT_BUDGET = 9_800;

/** Exported for tests — prompt length without context metadata (which is injected separately). */
export const NATIVE_PROMPT_STATIC = buildNativeSystemPrompt();
