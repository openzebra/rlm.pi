/**
 * The REPL vocabulary both prompts are built from.
 *
 * Headless (fenced ```repl``` blocks) and native (`repl({code})`) describe the same sandbox, so
 * every line either lives here once or has an explicit condensed native twin next to it — that
 * pairing is the whole reason this module exists. Divergence here is a bug: the model is told
 * about functions that do not exist, or not told about ones that do.
 */

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
export const RETRIEVAL_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `search(query: str, k=10, path_glob=None)`: BM25 ranking over `context`. Returns",
  "  [{path, line, score, snippet, text}] — POINTERS, not bodies (`text` aliases `snippet`).",
  "  **Start here.** Free: no sub-LLM call. Use before guessing filenames.",
  "- `grep_context(pattern, k=50, path_glob=None, before=0, after=0) -> dict`: regex over",
  "  `context`. Returns {hits: [{path, line, text, snippet}], counts, total, truncated} —",
  "  `counts` is complete even when `hits` is capped, so a wide pattern reports its shape",
  "  instead of flooding you. Use for exact lexical needles; use `search` for meaning.",
  "- `outline(path) -> str`: definition/heading skeleton of one file with line numbers.",
  "  Orient in ~200 chars instead of printing 20K. Matches exact path, then suffix, then glob.",
]);

/** v5 delegation doctrine (audit C5): children have NO retrieval tools — their world is the
 *  sliced `context` they were handed. This REPLACES the retrieval lines in child prompts so
 *  the prompt and the runtime sandbox agree (a child taught to `search` burns turns on NameError). */
export const DELEGATION_SURFACE_LINES: readonly string[] = Object.freeze([
  "- **No `search` / `grep_context` / `outline` / `add_context` in this REPL** (delegation",
  "  surface, v5 doctrine): your task arrived WITH its world in `context`. Explore it with",
  "  Python (list comprehensions, string matching, slicing) and delegate slices to sub-LLMs —",
  "  never re-ask the parent for retrieval.",
]);

/** One-line delegation helpers — orchestrating must be cheaper than solving. */
export const DELEGATION_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `map_files(files, prompt) -> Task`: always spawn. `await_task(t)` → dict[path, answer].",
  "  Accepts context entries or paths; packs into cap-sized batches; splits oversized files.",
  "  **Default way to read many files** — fire independent `map_files` Tasks, free work, then await.",
  "- `llm_map_reduce(items, map_prompt, reduce_prompt) -> str`: **blocks** (map then reduce).",
  "  Prefer separate `map_files` / `llm_batch` Tasks when you can do free work between fan-out and collect.",
]);

/** Shared glossary entry for the chunked-query helper (headless + native). */
export const CHUNKED_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `llm_query_chunked(text: str, prompt: str) -> Task`: always spawn. `await_task(t)` → list[str]",
  "  (one answer per chunk, order preserved). Auto-splits text to the sub-LLM prompt cap.",
  "  Use for ANY text too large for a single `llm_query` — open()ed files, oversized sub-results.",
]);

/** Non-blocking fan-out: spawn now, collect later (headless glossary). */
export const SPAWN_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- **ALWAYS SPAWN (Task + ↗bg):** `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` /",
  "  `map_files` / `llm_query_chunked`. Never treat the return as the answer.",
  "  Collect with `await_task(t)`, `await_task([t1,t2,…])`, or `await_task()` (every still-running Task).",
  "  `list_tasks()` → [{kind, label, done, var}]. Fire independent Tasks first, free work, then await.",
  "  Do NOT await after every independent spawn (serializes wall time). `task.done` when settled.",
  "- `[ledger]` global state: the blackboard in your prompt lists inflight/done agent claims.",
  "  NEVER `rlm_query` a task already on `[ledger]` (await it / reuse the result); ancestor",
  "  echo is rejected with a stub. `list_claims()` shows the live table anytime.",
  "- `spawn(fn, *args) -> Task`: same as calling the always-spawn tools (not `llm_map_reduce`).",
  "- Only `llm_map_reduce` still blocks until done.",
]);

/** v5 (audit C5): the spawn worked example, retrieval flavor — root surface only. */
export const SPAWN_EXAMPLE_RETRIEVAL: readonly string[] = Object.freeze([
  "",
  "  ```python",
  "  # Multi-area study: one rlm_batch (parallel workers), free locate, then await",
  "  t = rlm_batch([",
  "      \"Study module A — NO edits. Paths + symbols for X.\",",
  "      \"Study module B — NO edits. Report how Y is configured.\",",
  "  ])",
  "  hits = search(\"X OR Y\", k=10)",
  "  reports = await_task(t)",
  "  # One-shot extracts: map_files / llm_batch also return Task → await_task",
  "  ```",
]);

/** v5 (audit C5): the spawn worked example, delegation flavor — no retrieval, slice instead. */
export const SPAWN_EXAMPLE_DELEGATION: readonly string[] = Object.freeze([
  "",
  "  ```python",
  "  # Multi-area study: one rlm_batch (parallel workers), slice your world while they run",
  "  t = rlm_batch([",
  "      \"Answer from the FIRST half of the context only: paths + symbols for X.\",",
  "      \"Answer from the SECOND half only: report how Y is configured.\",",
  "  ])",
  "  half = [f['path'] for f in context[:len(context)//2]]  # free work while Tasks run",
  "  reports = await_task(t)",
  "  # One-shot extracts: map_files / llm_batch also return Task → await_task",
  "  ```",
]);
export const RECURSION_CONTEXT_LINES: readonly string[] = Object.freeze([
  "",
  "  **What a child sees:** it inherits YOUR `context` — every file you have loaded, including",
  "  sources under `ctx/<id>/…` — and runs `search` / `grep_context` / `outline` / `map_files`",
  "  over the same paths. So send instructions, never file bodies: pasting content you already",
  "  share costs your tokens twice and buys nothing. Your prompt becomes the child's question.",
  "  Narrow its world with `rlm_query(prompt, paths=['src/auth/', 'ctx/x-9f3a/'])` — path PREFIXES,",
  "  not globs. Omit `paths` to hand over everything.",
  "  Inheritance is one-way: sources the child loads, and its whole REPL, die with it — only its",
  "  final answer string returns. The child cannot write to your `answers` or `plan`.",
  "  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context, which is why",
  "  this section disappears at the last recursive depth.",
]);

/** v5 recursion section, delegation variant (audit C5): describes what a delegation child
 *  receives — the narrowed pack as text, no retrieval of its own. */
export const RECURSION_DELEGATION_LINES: readonly string[] = Object.freeze([
  "",
  "  **What a child sees:** it inherits YOUR `context` (narrowed by `paths=` when given) and works",
  "  on it as text — it has NO retrieval tools, so put what matters in your prompt and `paths`,",
  "  never file bodies you already share (that costs tokens twice and buys nothing).",
  "  Inheritance is one-way: sources the child loads, and its whole REPL, die with it — only its",
  "  final answer string returns. The child cannot write to your `answers` or `plan`.",
  "  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context, which is why",
  "  this section disappears at the last recursive depth.",
]);

/**
 * Sub-RLM orientation. Emitted only at depth > 0, where `context` is the parent's world rather
 * than a repository the run packed for itself.
 */
export const CHILD_CONTEXT_LINES: readonly string[] = Object.freeze([
  "  You are a sub-RLM. This `context` is your parent's world — every file it has loaded (cwd",
  "  paths un-prefixed; external sources under `ctx/<id>/…`). Answer only the question above;",
  "  your REPL and anything you load die with you, and only your final answer string returns.",
]);

/** Why a file the user mentioned may be missing from `context`. */
export const CONTEXT_EXCLUSION_NOTE = [
  "  NOTE: `context` holds only the files you have loaded (starts empty; cwd seeds on first use).",
  "  Gitignored files and files larger than 1MB of plain text are skipped. Binary documents",
  "  (PDF, DOCX, XLSX, PPTX, CSV, …) ARE included — converted to Markdown on the way in.",
].join("\n");

/** The large-on-disk-file protocol (headless + native). */
export const LARGE_FILE_RULE_LINES: readonly string[] = Object.freeze([
  "**Large on-disk files (profiles, logs, dumps, generated JSON):** files >1MB or gitignored are",
  "absent from `context`. Protocol:",
  '1. Load in Python: `raw = open("dhat-heap.json").read()` — loading into a variable is fine.',
  "2. Deterministic processing in Python (`json.load`, `re`, counting, aggregation) is fine and preferred.",
  "3. The moment you need MEANING from raw text (summarize, explain, find anomalies), do NOT read it",
  "   yourself — call `llm_query_chunked(raw, question)` (Task → await_task), or slice + `llm_batch`.",
  "4. Never print more than a small probe (~2K chars) of raw content.",
  'Example: `t = llm_query_chunked(raw, "Extract top allocation sites with byte totals"); parts = await_task(t)`, then',
  "aggregate `parts` in Python or with one final `llm_query` + await_task.",
]);

/** Concise native-mode glossary line for the chunked helper (native prompt has a 6K budget). */
export const CHUNKED_GLOSSARY_LINE_NATIVE =
  "- `llm_query_chunked(text, prompt) -> Task` — always spawn; await_task → list[str] (one answer per chunk). Auto-splits oversized text.";

/** Concise native-mode large-file rule (folds in the context-exclusion note; native 6K budget). */
export const LARGE_FILE_RULE_NATIVE =
  "- Files >1MB or gitignored are NOT in `context`: open() + parse deterministically in Python is fine; ANY semantic reading of the raw text goes through llm_query_chunked. Never print >2K chars raw.";

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
export const ENV_TIPS = [
  "## Decomposition doctrine",
  "",
  "**Orchestrate; don't solve.** A single chain of thought over a large repository drifts —",
  "you lose partials and compound mistakes. Sub-workers are competent: trust them; don't read for them.",
  "",
  "Your job: (1) free locate with `search` / `grep_context` / `outline`,",
  "(2) fan out: **multi-step areas → `rlm_batch` / `rlm_query`**; one-shot extracts →",
  "  `map_files` / `llm_batch` (all return Task — `await_task` for content),",
  "(3) memoize into `answers`, (4) sanity-check before dependents, (5) assemble from `answers`.",
  "Your own compute is: pointers, dict lookups, string formatting, and decisions.",
  "",
  "### The only state that matters",
  "`answers` and `plan` are dicts that persist across every turn.",
  "**If a result isn't in `answers`, you have not memoized it.** Task handles are REPL vars —",
  "`list_tasks()` / `SHOW_VARS()` find them. Do not trust truncated stdout. Memoize after await_task.",
  "",
  "### Shape of a run",
  "1. Probe: `print(len(context))`; locate targets with `search` when your surface has it, else",
  "   Python slicing / string matching. Do not print file bodies.",
  "2. Plan: sub-questions into `plan` (each from a named slice / module).",
  "3. Fan out **in parallel**: one `rlm_batch` for independent multi-step studies, or",
  "   `map_files` / `llm_batch` for one-shot reads — not one serial call per file.",
  "4. Assemble from `answers`.",
  "",
  "### Red flags — you are off track",
  "- Printing file bodies / native bulk read → stop; use map_files or rlm_*.",
  "- `llm_query(\"Read src/foo.ts…\")` with only a path — sub-LLM has **no disk**; use map_files/rlm_*.",
  "- Multi-module task with zero `rlm_batch`/`rlm_query`/`map_files` → under-delegating.",
  "- Await after every independent spawn → serializes wall time; fire-all-then-await.",
  "- Treating Task as the answer without `await_task`.",
  "- Regex used to *infer meaning* → sub-LLM job. Regex is for exact needles only.",
  "- Two turns with zero sub-LLM calls on analysis → solving it yourself.",
].join("\n");

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
    "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns. Only",
    "`print(...)` output (stdout) is returned; a bare expression on the last line is discarded, so",
    "always wrap inspections in `print(...)`.",
  ].join(" ");
}

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
      "- `context`: str — the raw text you must analyze. Probe it with slices",
      "  (`print(context[:2000])`), split it programmatically, and delegate large chunks",
      "  to sub-LLMs — never dump the whole string into your own output.",
    );
  } else {
    lines.push(
      "- `context`: list[dict] — the files you have loaded (starts empty; cwd seeds on first use).",
      "  Each dict has keys: `path` (str), `content` (str), `tokens` (int).",
      "  Cwd paths are un-prefixed (real paths for edit/write); external sources land under",
      "  `ctx/<source_id>/…`. For large sets, chunk and delegate — never dump raw file bodies.",
      CONTEXT_EXCLUSION_NOTE,
    );
    if (child) lines.push(...CHILD_CONTEXT_LINES);
    if (delegation) {
      lines.push(
        "",
        "  Worked example — slice the world you were handed, then delegate it (Task + await):",
        "  ```python",
        "  slice = [f for f in context if f['path'].startswith('src/auth/')][:6]",
        "  prompts = [f\"Answer from this file only.\\n\\n{f['content'][:4000]}\" for f in slice]",
        "  t = llm_batch(prompts)",
        "  answers.update(dict(zip([f['path'] for f in slice], await_task(t))))",
        "  ```",
      );
    } else {
      lines.push(
        "",
        "  Worked example — find the slice, then delegate it (Task + await):",
        "  ```python",
        '  hits = search("where is the retry/backoff policy configured?", k=8)',
        "  paths = sorted({h['path'] for h in hits})",
        '  t = map_files(paths, "Describe any retry/backoff policy in this file, with line numbers. Say NONE if absent.")',
        "  answers.update(await_task(t))",
        "  print({p: a[:80] for p, a in answers.items()})",
        "  ```",
      );
    }
  }
  if (delegation) {
    lines.push(...DELEGATION_SURFACE_LINES);
  } else {
    lines.push(...RETRIEVAL_GLOSSARY_LINES);
  }
  lines.push(
    "- `llm_query(prompt: str) -> Task`: spawn one sub-LLM (await_task for str). The prompt must",
    "  **contain the text** to analyze — this call has no filesystem and no `context`.",
    "- `llm_batch(prompts: list[str]) -> Task`: many parallel one-shots (same rule: embed text).",
    "  await_task → ordered list[str]. NEVER pass bare file paths as if the worker can open them.",
    ...CHUNKED_GLOSSARY_LINES,
    ...SPAWN_GLOSSARY_LINES,
    ...(delegation ? SPAWN_EXAMPLE_DELEGATION : SPAWN_EXAMPLE_RETRIEVAL),
    ...DELEGATION_GLOSSARY_LINES,
  );
  if (contextLoader && !delegation) {
    lines.push(
      "- `add_context(source: str) -> dict`: load a dir, file, document, or git URL and **APPEND its",
      "  files into `context`** (same shape: path/content/tokens). Documents (PDF, DOCX, XLSX, PPTX,",
      "  CSV, …) are converted to Markdown automatically and cached until the source file changes.",
      "  Paths are namespaced under `ctx/<source_id>/…` so you can filter by prefix. Returns metadata:",
      "  {\"source\", \"source_id\", \"path_prefix\", \"files\", \"chars\", \"context_len\", \"already_loaded\",",
      "  \"documents\", \"converted\", \"skipped\"} or an \"Error: ...\" string. `documents` is how many",
      "  document-type files landed (incl. cache hits); `converted` is how many were freshly converted",
      "  this call. **Never treat the return value as the file list** — always search and chunk the",
      "  single variable `context`. Idempotent: re-loading the same source is a no-op.",
      "",
      "  ```python",
      '  info = add_context("/path/to/other-project")',
      "  # info is metadata; files are already in context under info[\"path_prefix\"]",
      '  lib_files = [f for f in context if f["path"].startswith(info["path_prefix"])]',
      "  ```",
    );
  }
  if (recursion) {
    lines.push(
      "- `rlm_query(task|prompt, paths=None) -> Task` / `rlm_batch(tasks|prompts, paths=None) -> Task`:",
      "  always spawn + ↯bg. await_task for the report string(s). Child REPL is private.",
      "  Both spellings accepted; prefer `task`/`tasks`.",
      "",
      "  **Routing (api_v5):**",
      "  - `llm_query` / `llm_batch` / `map_files` — one-shot facts/extracts (fast).",
      delegation
        ? "  - `rlm_query` — one multi-step study (its own delegation loop; it cannot search either)."
        : "  - `rlm_query` — one multi-step study (own search/outline loop).",
      "  - `rlm_batch` — ≥2 independent multi-step studies in **parallel** (prefer over N× rlm_query).",
      "  Always Task → await_task. Fire independent work first; never serial-await between peers.",
      ...(delegation ? RECURSION_DELEGATION_LINES : RECURSION_CONTEXT_LINES),
    );
  }
  lines.push(
    "- `answers` / `plan`: two dicts that persist across turns. Memoize every",
    "  verified result in `answers` — see the decomposition doctrine below.",
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL (Task handles show as `<Task …>`).",
    "- `list_tasks()`: every Task this REPL created — [{kind, label, done, var}].",
    "- `memory.query(q) -> str` / `memory.add(text, paths=…, tags=…)`: durable notes under `.rlm/`",
    "  that survive across sessions. Query before re-studying a known area; add concise findings",
    "  (facts, locations, decisions) — never secrets or API keys (notes persist on disk).",
    "- `list_claims()`: the live `[ledger]` table of inflight/done agent work.",
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` to the answer text and `answer["ready"] = True`.',
    '  **You MUST flip `answer["ready"] = True` — runs that never finalize are discarded.**',
  );
  return lines.join("\n");
}
