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

/** One-line delegation helpers — orchestrating must be cheaper than solving. */
export const DELEGATION_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `map_files(files, prompt) -> dict[path, str]`: ask `prompt` of every file and",
  "  get back {path: answer}. Accepts context entries or paths, packs them into cap-sized",
  "  batched sub-calls, and splits oversized files automatically. **This is the default way to",
  "  read many files** — prefer it over hand-rolling a chunk loop.",
  "- `llm_map_reduce(items, map_prompt, reduce_prompt) -> str`: map over items in",
  "  one batch, then reduce the partial answers with a single call. The paper's canonical",
  "  strategy (query per chunk → aggregate the buffers) as one call.",
]);

/** Shared glossary entry for the chunked-query helper (headless + native). */
export const CHUNKED_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `llm_query_chunked(text: str, prompt: str) -> list[str]`: auto-splits `text` into",
  "  chunks that fit the sub-LLM prompt cap, fans them out concurrently (order preserved), and",
  "  returns one answer per chunk. Use it for ANY text too large for a single `llm_query` — a file",
  "  you open()ed, an oversized sub-result, or several concatenated context files.",
]);

/** Non-blocking fan-out: spawn now, collect later (headless glossary). */
export const SPAWN_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- **ALWAYS SPAWN:** `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` return a `Task`",
  "  immediately — never the answer. Collect with `await_task(t)` or `await_task([t1,t2,…])`.",
  "  Fire independent Tasks first, then await. `task.done` is True when settled.",
  "- `spawn(fn, *args) -> Task`: same as calling the tool for the four core tools; also",
  "  starts `llm_query_chunked` / `map_files` without waiting.",
  "  (Not `llm_map_reduce` — reduce depends on its own map results.)",
  "- `map_files` / `llm_query_chunked` / `llm_map_reduce` still block until done (helpers).",
  "",
  "  ```python",
  "  # ALWAYS: Task first, then await — never treat Task as the answer",
  "  t1 = llm_batch([\"q1\", \"q2\", \"q3\"])",
  "  t2 = rlm_batch([\"study A NO edits\", \"study B NO edits\"])",
  "  hits = search(\"timeout\")  # free work while host runs",
  "  answers = await_task([t1, t2])",
  "  ```",
]);

/**
 * What a parent must know about the child it is about to spawn. Without this the model writes
 * referential prompts ("read lib/x/src/…") on the assumption the child can go fetch them, which
 * is what made a missing child context degrade silently instead of failing (issue #4).
 */
export const RECURSION_CONTEXT_LINES: readonly string[] = Object.freeze([
  "",
  "  **What a child sees:** it inherits YOUR `context` — every file you have loaded, including",
  "  sources under `ctx/<id>/…` — and runs `search` / `grep_context` / `outline` / `map_files`",
  "  over the same paths. So send instructions, never file bodies: pasting content you already",
  "  share costs your tokens twice and buys nothing. Your prompt becomes the child's question.",
  "  Narrow its world with `rlm_query(prompt, paths=['src/auth/', 'ctx/x-9f3a/'])` — path PREFIXES,",
  "  not globs. Omit `paths` to hand over everything.",
  "  Inheritance is one-way: sources the child loads, and its whole REPL, die with it — only its",
  "  final answer string returns.",
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
  "   yourself — call `llm_query_chunked(raw, question)`, or slice + `llm_batch`.",
  "4. Never print more than a small probe (~2K chars) of raw content.",
  'Example: `parts = llm_query_chunked(raw, "Extract top allocation sites with byte totals")`, then',
  "aggregate `parts` in Python or with one final `llm_query`.",
]);

/** Concise native-mode glossary line for the chunked helper (native prompt has a 6K budget). */
export const CHUNKED_GLOSSARY_LINE_NATIVE =
  "- `llm_query_chunked(text, prompt) -> list[str]` — auto-splits oversized text into cap-sized chunks, fans out concurrently; one answer per chunk.";

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
  "you lose partials and compound mistakes. Your sub-LLMs are competent readers: given a",
  "self-contained prompt and the text, they will extract, locate, classify, and summarize",
  "reliably. Trust them; don't do their reading yourself.",
  "",
  "Your job: (1) find the relevant slice with `search` / `grep_context` / `outline`,",
  "(2) delegate all semantic reading to `map_files` / `llm_batch` / `llm_map_reduce`,",
  "(3) memoize every result you will reuse in `answers`, (4) sanity-check an answer before",
  "another step depends on it, (5) assemble the final answer from `answers` by lookup.",
  "Your own compute is: pointers, dict lookups, string formatting, and decisions.",
  "",
  "### The only state that matters",
  "`answers` and `plan` are dicts that persist across every turn.",
  "**If a value isn't in `answers`, it doesn't exist.** Do not trust a number from your own",
  "earlier reasoning or from truncated stdout — context drifts. Memoize everything you reuse.",
  "",
  "### Shape of a run",
  "1. Probe: `print(len(context))`, `search(<the user's question>)`. Do not print file bodies.",
  "2. Plan: write the sub-questions into `plan`; each must be answerable from a named slice.",
  "3. Fan out: one `map_files` / `llm_batch` per independent group, not one call per",
  "   file. Store results into `answers` keyed by path or sub-question.",
  "4. Assemble: build the answer from `answers`. Delegate the aggregation too if it is large.",
  "",
  "### Red flags — you are off track",
  "- Printing file bodies to read them yourself → stop, delegate to `map_files`.",
  "- Writing regex to *infer meaning* (naming conventions, intent, correctness) → that is a",
  "  sub-LLM job. Regex is for exact lexical needles only.",
  "- Two turns in with zero sub-LLM calls on an analysis task → you are solving it yourself.",
  "- About to reuse a value that is not in `answers` → re-derive it and store it.",
  "- One sub-call per file over dozens of files → batch them; fat prompts in small batches win.",
].join("\n");

/** Native-mode variant of the doctrine — same rules, sized for the native prompt budget. */
export const ENV_TIPS_CONDENSED = [
  "### Decomposition doctrine (paper App. C.3 — worth +69.5% there)",
  "Orchestrate; don't solve. Loop: `search`/`grep_context`/`outline` to find the slice →",
  "`map_files` / `llm_batch` to read it → memoize into `answers` → assemble by lookup.",
  "`answers` and `plan` persist across every turn: **if a value isn't in `answers`, it",
  "doesn't exist** — never reuse a number from your own earlier reasoning or truncated stdout.",
  "Red flags: printing file bodies to read them; regex used to infer meaning rather than match",
  "a literal; two turns into an analysis with zero sub-LLM calls; one sub-call per file instead",
  "of one batch. Exception — AUTHORING is not reading: you write every edit body yourself.",
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
    lines.push(
      "",
      "  Worked example — find the slice, then delegate it:",
      "  ```python",
      '  hits = search("where is the retry/backoff policy configured?", k=8)',
      "  paths = sorted({h['path'] for h in hits})",
      '  answers.update(map_files(paths, "Describe any retry/backoff policy in this file, with line numbers. Say NONE if absent."))',
      "  print({p: a[:80] for p, a in answers.items()})",
      "  ```",
    );
  }
  lines.push(...RETRIEVAL_GLOSSARY_LINES);
  lines.push(
    "- `llm_query(prompt: str) -> Task`: spawn one sub-LLM (await_task for str). Extraction,",
    "  summarization, Q&A over a chunk. No per-call model override.",
    "- `llm_batch(prompts: list[str]) -> Task`: spawn many sub-LLMs in parallel",
    "  (await_task → ordered list[str]). ALWAYS returns Task — never a list directly.",
    ...CHUNKED_GLOSSARY_LINES,
    ...SPAWN_GLOSSARY_LINES,
    ...DELEGATION_GLOSSARY_LINES,
  );
  if (contextLoader) {
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
      "- `rlm_query(task, paths=None) -> Task` / `rlm_batch(tasks, paths=None) -> Task`:",
      "  always spawn. await_task for the report string(s). Child REPL is private.",
      "",
      "  **Choosing between `llm_query` and `rlm_query`:**",
      "  - `llm_query` / `llm_batch` for one-shot facts (fast). Always Task → await_task.",
      "  - `rlm_query` / `rlm_batch` when multi-step locate/edit is needed. Always Task → await_task.",
      ...RECURSION_CONTEXT_LINES,
    );
  }
  lines.push(
    "- `answers` / `plan`: two dicts that persist across turns. Memoize every",
    "  verified result in `answers` — see the decomposition doctrine below.",
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL.",
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` to the answer text and `answer["ready"] = True`.',
  );
  return lines.join("\n");
}
