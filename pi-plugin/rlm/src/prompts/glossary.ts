/**
 * The REPL vocabulary both prompts are built from.
 *
 * Headless (fenced ```repl``` blocks) and native (`repl({code})`) describe the same sandbox, so
 * every line either lives here once or has an explicit condensed native twin next to it — that
 * pairing is the whole reason this module exists. Divergence here is a bug: the model is told
 * about functions that do not exist, or not told about ones that do.
 */

import { ARCHIVE_NAMESPACE } from "../core/session-archive.ts";

export type ContextKind = "files" | "text";

/** "str" (raw string context, e.g. rlm_query children) → text; everything else → files. */
export function contextKindOf(contextType: string): ContextKind {
  return contextType === "str" ? "text" : "files";
}

export const DEFAULT_PROMPT_CAP = 400_000;

export function promptCapTokensK(maxPromptChars: number): number {
  return Math.round(maxPromptChars / 4_000);
}

/**
 * Deterministic retrieval over `context` (headless + native).
 *
 * The paper's trajectories retrieve with hand-written regex (App. E.1); frontier models do that
 * well, small ones guess keywords badly, and the first decomposition disproportionately decides
 * the outcome (§5, Fig. 4a). These cost no tokens and no sub-calls.
 */
const RETRIEVAL_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `search(query: str, k=10, path_glob=None) -> [{path, line, end, score, snippet, text}]`: free BM25 pointers (`text` aliases `snippet`; `index_truncated: true` ⇒ narrow with `path_glob`). **Start here.**",
  "- `grep_context(pattern, k=50, path_glob=None, before=0, after=0) -> {hits, counts, total, truncated}`: free regex over `context` (`counts` is complete even when `hits` is capped).",
  "- `outline(path) -> str`: free definition/heading skeleton with line numbers (~200 chars).",
]);

/** v5 delegation doctrine (audit C5): children have NO retrieval tools — their world is the
 *  sliced `context` they were handed. This REPLACES the retrieval lines in child prompts so
 *  the prompt and the runtime sandbox agree (a child taught to `search` burns turns on NameError). */
const DELEGATION_SURFACE_LINES: readonly string[] = Object.freeze([
  "- **No `search` / `grep_context` / `outline` / `add_context` in this REPL**: your task arrived WITH its world in `context`; slice it in Python and delegate slices to sub-LLMs.",
]);

/** Workstream E: the one new sandbox function (prime-agent rule — surface grows by one). */
const SKILL_SEARCH_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `skill_search(query, k=8) -> [{id, text, tags, score}]`: free BM25 over prior-session project facts (SkillState).",
]);

/** W3 recall discoverability: the condensed NATIVE twins. glossary doctrine — divergence
 *  between the headless and native surfaces is a bug; `skill_search` had no native twin, so
 *  native models could not discover cross-session recall at all (and the archive line
 *  teaches the ctx/session-log recall that honest elision stubs point at). */
export const SKILL_SEARCH_LINE_NATIVE =
  "- `skill_search(query, k=8) -> [{id, text, tags, score}]` — BM25 over distilled project facts from PRIOR sessions. Free; use before re-discovering a learned config/gotcha/symbol.";
export const ARCHIVE_RECALL_LINE_NATIVE =
  `- Elided chat turns are archived in the sandbox: \`search("<keywords>", path_glob="${ARCHIVE_NAMESPACE}*")\` / \`grep_context()\` recall text that scrolled out of your context — free, no sub-LLM call.`;

/** Single source of wording for the injected SkillState block (headless + native, Workstream C).
 *  Takes the dynamic body as an argument — the glossary itself stays static-only. */
/** One wording source for the skill_search recall hint (Ξ block + root Σ snapshot). */
export const SKILL_RECALL_LINE =
  "Recall more anytime inside repl: `skill_search(query, k=8)` → [{id, text, tags, score}].";

/** R5 (G4, /tmp/ROOT_FULL_SKILLSTATE_PLAN.md): the one-line replacement for assistant prose
 *  older than the keep window — durable facts live in Σ; the repl sandbox (answers/vars) is
 *  the model-reachable recovery channel for repl-owned payloads. Stubs must promise only a
 *  channel that actually holds the bytes (recall W1): repl-owned payloads → the repl line,
 *  native payloads → the archive line (searchable `ctx/session-log/`), else the plain line. */
export const ROOT_TURN_ELIDED_LINE =
  "… turn elided — durable facts live in Σ; your repl sandbox persists: print(answers) / SHOW_VARS() to re-derive";
export const ROOT_TURN_ELIDED_ARCHIVE_LINE =
  `… turn elided — durable facts live in Σ; the full text is archived in the sandbox: ` +
  `search('<keywords>', path_glob='${ARCHIVE_NAMESPACE}*') or grep_context() recalls it`;
export const ROOT_TURN_ELIDED_PLAIN_LINE =
  "… turn elided — durable facts live in Σ";
/** Preview mark twin: payloads kept as head+tail previews point at the same archive. */
export const ROOT_ELIDE_PREVIEW_MARK =
  `chars elided — full text archived under ${ARCHIVE_NAMESPACE} (search/grep_context it)`;
export const ROOT_ELIDE_PREVIEW_MARK_REPL =
  "chars elided — repl sandbox persists: print(answers[k]) or re-run repl to re-derive";

export function skillStateLines(noteCount: number, body: string): string {
  return [
    `[Project facts — SkillState, ${noteCount} note${noteCount === 1 ? "" : "s"}, distilled from prior sessions]`,
    body,
    SKILL_RECALL_LINE,
  ].join("\n");
}

/** Root Σ WS-2 digest wording — the single source for the header and section labels. */
export const ROOT_DIGEST_HEADER =
  "[Root digest — deterministic structural compaction (no model call). Older turns are " +
  "superseded by this digest plus the verbatim tail that follows; fresh tool results " +
  "outrank the digest when they disagree.]";
export const ROOT_DIGEST_SECTIONS: Readonly<Record<"task" | "findings" | "state" | "next" | "facts", string>> =
  Object.freeze({ task: "Task", findings: "Findings", state: "State", next: "Next", facts: "Project facts" });

/** One-line delegation helpers — orchestrating must be cheaper than solving. */
const DELEGATION_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `map_files(files, prompt) -> Task`: spawn; `await_task(t)` → `dict[path, answer]`. Default way to read many files.",
  "- `llm_map_reduce(items, map_prompt, reduce_prompt) -> str`: **blocks** (map then reduce); prefer `map_files` / `llm_batch` Tasks.",
]);

/** Shared glossary entry for the chunked-query helper (headless + native). */
const CHUNKED_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `llm_query_chunked(text: str, prompt: str) -> Task`: spawn; `await_task(t)` → `list[str]` (auto-splits oversized text).",
]);

/** Non-blocking fan-out: spawn now, collect later (headless glossary). */
const SPAWN_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- **ALWAYS SPAWN (Task + ↗bg):** `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` / `map_files` / `llm_query_chunked` return a `Task`, never the answer.",
  "  Collect with `await_task(t)`, `await_task([t1,t2,…])`, or `await_task()` (all running). If `await_task` returns `Error: sub-call still running`, call it again — do not respawn.",
  "  Fire independent Tasks first, do free work, then `await_task`. `spawn(fn, *args) -> Task` aliases the spawn tools (not `llm_map_reduce`).",
  "- `[ledger]`: live inflight/done claims (`list_claims()`). Never `rlm_query` a task already on `[ledger]`.",
]);

const SPAWN_EXAMPLE_RETRIEVAL: readonly string[] = Object.freeze([
  "  ```python",
  '  t = rlm_batch(["Study module A — NO edits.", "Study module B — NO edits."])',
  '  hits = search("X OR Y", k=10)',
  "  reports = await_task(t)",
  "  ```",
]);

const SPAWN_EXAMPLE_DELEGATION: readonly string[] = Object.freeze([
  "  ```python",
  "  # slice the world you were handed, then fan out:",
  '  slice = [f for f in context if f["path"].startswith("src/auth/")][:6]',
  '  t = llm_batch([f"Answer from this file only:\\n\\n{f[\'content\'][:4000]}" for f in slice])',
  '  answers.update(dict(zip([f["path"] for f in slice], await_task(t))))',
  "  ```",
]);

const RECURSION_CONTEXT_LINES: readonly string[] = Object.freeze([
  "  **Child context:** inherits your `context` (narrow with `paths=['src/auth/']` prefixes; never paste file bodies). One-way: child REPL dies with it; only its answer string returns. Degrades to `llm_query` at depth cap.",
]);

const RECURSION_DELEGATION_LINES: readonly string[] = Object.freeze([
  "  **Child context:** inherits your `context` (narrowed by `paths=`) as text with NO retrieval tools. One-way: child REPL dies with it; only its answer string returns.",
]);

/**
 * Sub-RLM orientation. Emitted only at depth > 0, where `context` is the parent's world rather
 * than a repository the run packed for itself.
 */
const CHILD_CONTEXT_LINES: readonly string[] = Object.freeze([
  "  You are a sub-RLM. `context` is your parent's world (`ctx/<id>/…` for external sources). Your REPL dies with you; only your final answer returns.",
]);

const CONTEXT_EXCLUSION_NOTE =
  "  NOTE: `context` starts empty (cwd seeds on first use). Gitignored files and plain text >1MB are skipped; binary docs (PDF/DOCX/XLSX/PPTX/CSV) are converted to Markdown.";

/** Stdout-budget wording — the ONE source for the per-print / per-block elision markers.
 *  core/answer.ts composes these into its segments (head/tail math stays in
 *  text/parsing.ts truncateOutput); guidance numbers live in limits.ts + system.ts. */
export function stdoutElidedMark(cutChars: number, capChars: number): string {
  return `[… ${cutChars.toLocaleString()} chars elided — per-print stdout cap ${capChars.toLocaleString()}; ` +
    "full output lives in your REPL vars, re-print the slice you need: print(big_var[a:b])]";
}

export function stdoutBulkMark(elidedCount: number, capChars: number): string {
  return `[… ${elidedCount} middle print output(s) elided — per-block stdout cap ${capChars.toLocaleString()}; ` +
    "slice big dumps in Python (print(v[a:b])) or delegate bulk reading to llm_query_chunked]";
}

/** The large-on-disk-file protocol (headless + native). */
export const LARGE_FILE_RULE_LINES: readonly string[] = Object.freeze([
  "**Large/gitignored files (>1MB):** `raw = open(p).read()` + Python parsing is fine; for semantic reading use `llm_query_chunked(raw, question)` → `await_task`. Never bulk-print raw text.",
]);

/** Concise native-mode glossary line for the chunked helper (native prompt has a 6K budget). */
export const CHUNKED_GLOSSARY_LINE_NATIVE =
  "- `llm_query_chunked(text, prompt) -> Task` — always spawn; await_task → list[str] (one answer per chunk). Auto-splits oversized text.";

/** Concise native-mode large-file rule (folds in the context-exclusion note; native 6K budget). */
export const LARGE_FILE_RULE_NATIVE =
  "- Files >1MB or gitignored are NOT in `context`: open() + parse deterministically in Python is fine; ANY semantic reading of the raw text goes through llm_query_chunked. Never bulk-print raw text; prints are per-call capped — slice or delegate.";

/**
 * The decomposition doctrine, ported from the RLM paper's Appendix C.3 `<env_tips>` and
 * retargeted from competition math to repository analysis.
 *
 * This block is the single highest-leverage prompt intervention the paper reports: +69.5% on
 * LongCoT-mini over the same RLM without it (Table 2). Plain RLM prompting alone actually
 * *regressed* two of the five categories; the doctrine is what fixed them. Its purpose is to
 * counter under-delegation — the model doing the work itself in the REPL instead of fanning out.
 *
 * Note the counterweight: `orchestratorAddendum` carries the anti-OVER-recursion batching rule.
 * The paper is explicit (App. B) that one prompt does not port across models and that both
 * guardrails are needed; keep them both.
 */
/** Decomposition doctrine. `delegation` drops retrieval names (audit R3) — children
 *  have no `search` and must not be told to locate with it. */
export function envTips(delegation = false): string {
  const locate = delegation
    ? "1. Locate: slice `context` in Python (`print(len(context))`). Do not print file bodies."
    : "1. Locate: `print(len(context))`; free locate with `search` / `grep_context` / `outline` (or Python slicing). Do not print file bodies.";
  return [
    "## Decomposition doctrine",
    "Orchestrate; don't brute-force. Leaf workers (`llm_query`/`llm_batch`) are fast non-thinking readers: use them to extract/screen slices, then audit borderline judgements yourself (`rlm_query` when a sub-area needs its own reasoning loop).",
    locate,
    "2. Fan out in parallel: multi-step areas → `rlm_batch` / `rlm_query`; one-shot extracts → `map_files` / `llm_batch` → `await_task`.",
    "3. Memoize into `answers` (`plan` for sub-questions), audit borderline items yourself, then assemble from `answers`.",
    "Red flags: bulk file prints; `llm_query` with path-only (no disk!); awaiting after each spawn instead of batching; treating `Task` as the answer; trusting unreviewed `llm_query` counts on subtle criteria.",
  ].join("\n");
}

/** Native-mode variant of the doctrine — same rules, sized for the native prompt budget. */
export const ENV_TIPS_CONDENSED = [
  "### Decomposition doctrine",
  "Orchestrate; don't solve. Free locate → fan-out Tasks → await_task → memoize in `answers`.",
  "Multi-module / multi-step areas: **`rlm_batch` (or rlm_query)** — not serial native read.",
  "One-shot extracts: `map_files` / `llm_batch`. Always Task → await_task; fire-all then await.",
  "`answers`/`plan` persist collected results. Task handles are REPL vars (`list_tasks()` / `SHOW_VARS()`).",
  "Red flags: bulk file dumps; llm_query with path-only (no content — no disk!); zero rlm_*/map_files",
  "on multi-area tasks; await after each spawn; Task treated as answer.",
  "AUTHORING: you write every edit body yourself.",
].join("\n");

export function howToRunCode(): string {
  return [
    "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns.",
    "Stdout is what comes back: `print(...)`, and the value of a trailing bare expression",
    "(it is echoed). Anything that is not the last line still needs `print`.",
  ].join(" ");
}

/** One wording for both prompts: `ctx/<id>/` names are inside `context`, not on disk. */
export const CTX_VIRTUAL_PATH_NOTE =
  "`ctx/<id>/…` paths are keys inside `context`, not disk paths. Read with `outline(path)` " +
  "or `next(f[\"content\"] for f in context if f[\"path\"] == path)`.";

export function replGlossary(
  kind: ContextKind,
  recursion: boolean,
  contextLoader: boolean,
  child: boolean,
  delegation = false,
): string {
  const lines = ["Available in the REPL:"];
  if (kind === "text") {
    lines.push(
      "- `context`: str — raw text to analyze. Probe slices (`print(context[:1000])`), split in Python, and delegate large chunks.",
    );
  } else {
    lines.push(
      "- `context`: `list[dict]` (`path`, `content`, `tokens`). " + CTX_VIRTUAL_PATH_NOTE,
      CONTEXT_EXCLUSION_NOTE,
    );
    if (child) lines.push(...CHILD_CONTEXT_LINES);
    if (!delegation) {
      lines.push(
        "  ```python",
        '  hits = search("retry backoff", k=8)',
        '  answers.update(await_task(map_files(sorted({h["path"] for h in hits}), "Retry policy + lines; NONE if absent.")))',
        "  ```",
      );
    }
  }
  lines.push(...(delegation ? DELEGATION_SURFACE_LINES : RETRIEVAL_GLOSSARY_LINES));
  lines.push(
    "- `llm_query(prompt: str) -> Task` / `llm_batch(prompts: list[str]) -> Task`: non-thinking leaf extractors (`await_task` → `str` / `list[str]`). Embed the text in the prompt (no disk, no `context`). Replies `NOT_FOUND` when absent.",
    ...CHUNKED_GLOSSARY_LINES,
    ...SPAWN_GLOSSARY_LINES,
    ...SKILL_SEARCH_GLOSSARY_LINES,
    ...(delegation ? SPAWN_EXAMPLE_DELEGATION : SPAWN_EXAMPLE_RETRIEVAL),
    ...DELEGATION_GLOSSARY_LINES,
  );
  if (contextLoader && !delegation) {
    lines.push(
      "- `add_context(source: str) -> dict`: APPEND a dir, file, doc, or git URL into `context` under `ctx/<source_id>/…` (idempotent; returns metadata `{source, source_id, path_prefix, files, chars, context_len, already_loaded, documents, converted, skipped}`).",
    );
  }
  if (recursion) {
    lines.push(
      "- `rlm_query(task|prompt, paths=None) -> Task` / `rlm_batch(tasks|prompts, paths=None) -> Task`: spawn thinking sub-RLM(s) (`await_task` → report str(s)).",
      ...(delegation ? RECURSION_DELEGATION_LINES : RECURSION_CONTEXT_LINES),
    );
  }
  lines.push(
    "- `answers` / `plan`: persistent dicts across turns (`SHOW_VARS()`, `list_tasks()`, `list_claims()`).",
    '- `answer`: `{"content": "", "ready": False}`. Submit by setting `answer["content"]` to the full report/answer text (never a status word like `"done"`/`"ready"` or a pointer to `answers[k]`) and `answer["ready"] = True` (never `FINAL(...)` prose or a ```state fence on the finalizing turn).',
  );
  return lines.join("\n");
}
