/**
 * RLM system prompt (ported from rlm/utils/prompts.py).
 *
 * The root model runs Python by writing fenced ```repl``` blocks (headless engine). The REPL
 * exposes `context`, the sub-LLM functions, and the `answer` dict the model flips to submit.
 */
import type { ContextSizeStats } from "../text/tokens.ts";

export interface PromptMeta {
  readonly contextType: string;
  readonly contextChars: number;
  readonly contextStats?: ContextSizeStats;
  readonly rootPrompt?: string;
}

export interface SystemPromptOptions {
  readonly orchestrator?: boolean;
  readonly recursion?: boolean;
  readonly askUserQuestion?: boolean;
  readonly todo?: boolean;
  readonly pipeline?: boolean;
  readonly maxPromptChars?: number;
}

export type ContextKind = "files" | "text";

/** "str" (raw string context, e.g. rlm_query children) → text; everything else → files. */
export function contextKindOf(contextType: string): ContextKind {
  return contextType === "str" ? "text" : "files";
}

const DEFAULT_PROMPT_CAP = 400_000;

function promptCapTokensK(maxPromptChars: number): number {
  return Math.round(maxPromptChars / 4_000);
}

/** Shared glossary entry for the chunked-query helper (headless + native). */
const CHUNKED_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `llm_query_chunked(text: str, prompt: str, model=None) -> list[str]`: auto-splits `text` into",
  "  chunks that fit the sub-LLM prompt cap, fans them out concurrently (order preserved), and",
  "  returns one answer per chunk. Use it for ANY text too large for a single `llm_query` — a file",
  "  you open()ed, an oversized sub-result, or several concatenated context files.",
]);

/** Why a file the user mentioned may be missing from `context`. */
const CONTEXT_EXCLUSION_NOTE =
  "  NOTE: files larger than 1MB and gitignored files are NOT in `context` — they exist only on disk.";

/** The large-on-disk-file protocol (headless + native). */
const LARGE_FILE_RULE_LINES: readonly string[] = Object.freeze([
  "**Large on-disk files (profiles, logs, dumps, generated JSON):** files >1MB or gitignored are",
  "absent from `context`. Protocol:",
  '1. Load in Python: `raw = open("dhat-heap.json").read()` — loading into a variable is fine.',
  "2. Deterministic processing in Python (`json.load`, `re`, counting, aggregation) is fine and preferred.",
  "3. The moment you need MEANING from raw text (summarize, explain, find anomalies), do NOT read it",
  "   yourself — call `llm_query_chunked(raw, question)`, or slice + `llm_query_batched`.",
  "4. Never print more than a small probe (~2K chars) of raw content.",
  'Example: `parts = llm_query_chunked(raw, "Extract top allocation sites with byte totals")`, then',
  "aggregate `parts` in Python or with one final `llm_query`.",
]);

/** Concise native-mode glossary line for the chunked helper (native prompt has a 6K budget). */
const CHUNKED_GLOSSARY_LINE_NATIVE =
  "- `llm_query_chunked(text, prompt, model=None) -> list[str]` — auto-splits oversized text into cap-sized chunks, fans out concurrently; one answer per chunk.";

/** Concise native-mode large-file rule (folds in the context-exclusion note; native 6K budget). */
const LARGE_FILE_RULE_NATIVE =
  "- Files >1MB or gitignored are NOT in `context`: open() + parse deterministically in Python is fine; ANY semantic reading of the raw text goes through llm_query_chunked. Never print >2K chars raw.";

function howToRunCode(): string {
  return [
    "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns. Only",
    "`print(...)` output (stdout) is returned; a bare expression on the last line is discarded, so",
    "always wrap inspections in `print(...)`.",
  ].join(" ");
}

function replGlossary(kind: ContextKind, recursion: boolean, askUserQuestion: boolean, todo: boolean, pipeline: boolean): string {
  const lines = ["Available in the REPL:"];
  if (kind === "text") {
    lines.push(
      "- `context`: str — the raw text you must analyze. Probe it with slices",
      "  (`print(context[:2000])`), split it programmatically, and delegate large chunks",
      "  to sub-LLMs — never dump the whole string into your own output.",
    );
  } else {
    lines.push(
      "- `context`: list[dict] — a pre-packed JSON array of every file in the repository. Each dict has",
      "  keys: `path` (relative file path, str), `content` (file text, str), `tokens` (estimated count, int).",
      "  For large repos, chunk `context` into batches and delegate to sub-LLMs — never dump raw file",
      "  bodies into your own output.",
      CONTEXT_EXCLUSION_NOTE,
      "",
      "  Chunking example:",
      "  ```python",
      "  chunk_size = 5",
      "  for i in range(0, len(context), chunk_size):",
      "      batch = context[i:i+chunk_size]",
      "      results = llm_query_batched([",
      "          f\"Analyze {f['path']} ({f['tokens']} tok):\\n{f['content']}\"",
      "          for f in batch",
      "      ])",
      "  ```",
    );
  }
  lines.push(
    "- `llm_query(prompt: str, model=None) -> str`: a single sub-LLM completion. Use for extraction,",
    "  summarization, or Q&A over a chunk of text.",
    "- `llm_query_batched(prompts: list[str], model=None) -> list[str]`: run several sub-LLM calls",
    "  concurrently; output order matches input order.",
    ...CHUNKED_GLOSSARY_LINES,
  );
  if (askUserQuestion) {
    lines.push(
      "- `ask_user_question(questions: list[dict]) -> list[dict]`: pause and present the user",
      "  with 1-4 structured questions. Each question: {question, header, options: [{label, description}],",
      "  multiSelect?}. Returns list of {question, selected: [label], custom?}.",
      "  Use when you have 2-4 concrete options from your analysis and need a decision before proceeding.",
      "  DO NOT ask open-ended chat questions — use concrete options grounded in code/data.",
      "  Only valid at root depth; returns an error inside rlm_query sub-calls.",
    );
  }
  if (todo) {
    lines.push(
      "- `todo(action, **kwargs) -> str`: manage a task list visible to the user.",
      "  Actions: create(subject, description?, status='pending'), update(id, status?, activeForm?),",
      "  list(filterStatus?), get(id), delete(id), clear().",
      "  Status flow: pending → in_progress → completed.",
      "  Use to plan multi-step work before starting, then mark tasks as you complete them.",
    );
  }
  if (recursion) {
    lines.push(
      "- `rlm_query(prompt, model=None)` / `rlm_query_batched(prompts, model=None)`: recursive RLM",
      "  sub-calls. Each child runs a full REPL loop internally — its entire conversation is PRIVATE",
      "  and never enters your history. Only the final answer (a short string) is returned.",
      "",
      "  **Choosing between `llm_query` and `rlm_query`:**",
      "  - `llm_query` for simple one-shot tasks — summarize a chunk, extract a fact, answer a direct",
      "    question. It is a single LLM call: fast and cheap. Prefer it by default, and fan out with",
      "    `llm_query_batched` for parallel one-shots.",
      "  - `rlm_query` only when a sub-task genuinely needs iterative reasoning with its own code",
      "    execution (e.g. a sub-context large enough to need its own chunking, or a multi-step",
      "    reasoning chain). It is slower and more expensive — reserve it for cases `llm_query` cannot",
      "    handle. Avoid excessive recursive sub-calls when a batched one-shot would suffice.",
    );
  }
  if (pipeline) {
    lines.push(
      "- `advance_phase(phase: str, summary=None) -> str`: transition the root RLM pipeline to the next phase.",
      "  Valid phases in order: 'research' → 'blueprint' → 'implement' → 'validate'. You must advance forward",
      "  one phase at a time. Only callable at the root depth; returns an error in sub-RLM contexts.",
    );
  }
  lines.push(
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL.",
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` to the answer text and `answer["ready"] = True`.',
  );
  return lines.join("\n");
}

function orchestratorAddendum(maxPromptChars: number): string {
  return [
    "As an RLM you are an **orchestrator, not a solver**. After you probe `context` and understand the",
    "task, pause and plan: state how the task decomposes into sub-LLM / REPL steps, then execute one step",
    "at a time, printing a small sample of each result to verify before moving on.",
    "",
    "Your own context window is small. Push every long-context operation — reading, summarizing,",
    "classifying, answering sub-questions — into `llm_query` / `llm_query_batched` instead of pulling raw",
    "text into your own message stream. Conversely, if a Python keyword/regex search over `context` would",
    "already pin the answer, just read it directly. Aggregate the small results back in Python.",
    "",
    `Sub-call budget is finite on two axes: (1) per-prompt capacity — each sub-prompt must stay under ${maxPromptChars.toLocaleString()} characters`,
    `(hard cap; ≈${promptCapTokensK(maxPromptChars)}K tokens), packing a chunk of many items per call; (2) batch fan-out —`,
    "keep batches to roughly ~20 prompts. Fat prompts in small batches beat thousands of tiny prompts.",
    "If the workload exceeds both at once, filter aggressively in Python first, then batch the survivors.",
    "",
    "Reserve your own tokens for high-level decisions: what to ask next, how to combine sub-LM outputs,",
    "when to finalize. Delegate everything else. Do not submit a final answer before inspecting `context`.",
  ].join("\n");
}

const INTRO = [
  "You are a Recursive Language Model (RLM): a language model with a prompt and a very important",
  "context stored in a Python REPL. You interact with the REPL turn-by-turn until you have an answer.",
].join(" ");

/** Build the full RLM system prompt. */
export function buildRlmSystemPrompt(meta: PromptMeta, opts: SystemPromptOptions = {}): string {
  const recursion = opts.recursion ?? false;
  const kind = contextKindOf(meta.contextType);
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_PROMPT_CAP;
  const parts = [
    INTRO,
    "",
    howToRunCode(),
    "",
    replGlossary(kind, recursion, opts.askUserQuestion ?? false, opts.todo ?? false, opts.pipeline ?? false),
    "",
    "REPL stdout over ~800 characters is truncated to a short excerpt — large results stay in your",
    "REPL variables as buffers. Re-print only the slice you need (e.g. `print(result[:500])`); never",
    "dump a whole sub-LLM result. The full content persists across turns in REPL variables (call `SHOW_VARS()`).",
    "",
    "Start by probing `context` (print a few lines, count items). Then build up an answer to the query.",
  ];
  if (opts.orchestrator ?? true) {
    parts.push("", orchestratorAddendum(maxPromptChars));
  }
  if (kind === "files") {
    parts.push("", LARGE_FILE_RULE_LINES.join("\n"));
  }
  parts.push("", buildMetadataLine(meta, maxPromptChars));
  return parts.join("\n");
}

/** Adapts the REPL glossary for native mode — agent calls `repl({code})` instead of writing ```repl``` blocks. */
function nativeReplGlossary(): string {
  return [
    "## RLM Native Mode — Persistent Python REPL",
    "",
    "Call `repl({code: \"...\"})` to execute Python in a **persistent** sandbox. Variables, imports,",
    "State persists; only `print()` output is returned, so wrap inspections in `print(...)`.",
    "",
    "### REPL Environment",
    "- `context`: list[dict] — every file in the repository. Each dict: `path` (str), `content` (str), `tokens` (int).",
    "- `llm_query(prompt, model=None) -> str` — one-shot sub-LLM. Use for extraction, summarization, Q&A over a chunk.",
    "- `llm_query_batched(prompts, model=None) -> list[str]` — concurrent sub-LLM calls; output order matches input order.",
    CHUNKED_GLOSSARY_LINE_NATIVE,
    "- `rlm_query(prompt, model=None) -> str` — recursive RLM with its own REPL for complex sub-tasks needing iterative reasoning.",
    "- `rlm_query_batched(prompts, model=None) -> list[str]` — concurrent recursive RLM calls.",
    "",
    "**Choosing between `llm_query` and `rlm_query`:** default to `llm_query`/batched; use `rlm_query` only for iterative sub-tasks.",
    "- `todo(action, **kwargs) -> str` — manage a task list. Actions: create, update, list, get, delete, clear. Statuses: pending → in_progress → completed.",
    "- `SHOW_VARS() -> str` — list all variables currently in the REPL.",
    "- `stage_edit(path, old_text, new_text)`: stage exact edits from `context`; apply returned STAGED_EDITS verbatim with edit().",
    "- `answer`: dict `{\"content\": \"\", \"ready\": False}`. To submit: `answer[\"content\"] = \"...\"; answer[\"ready\"] = True`.",
    "",
    "### Orchestrator Pattern",
    "You are an **orchestrator, not a solver**. After probing `context`, decompose the task into sub-LLM / REPL steps,",
    "then execute one step at a time, printing samples of each result to verify before moving on.",
    "",
    "Push every long-context operation (reading, summarizing, classifying, answering sub-questions) into",
    "`llm_query` / `llm_query_batched` — never dump raw file bodies into your own output. Aggregate small",
    "results back in Python. Use Python string operations (`in`, `re.search`) over `context` for quick lookups.",
    "",
    "### Chunking Strategy",
    "```python",
    "chunk_size = 10",
    "for i in range(0, len(context), chunk_size):",
    "    batch = context[i:i+chunk_size]",
    "    results = llm_query_batched([",
    "        f\"Analyze {f['path']} ({f['tokens']} tok):\\n{f['content']}\"",
    "        for f in batch",
    "    ])",
    "    # aggregate results into a buffer",
    "```",
    `- Keep sub-prompts under ${DEFAULT_PROMPT_CAP.toLocaleString()} characters (≈${promptCapTokensK(DEFAULT_PROMPT_CAP)}K tokens); batch ~20 prompts per call. Fat prompts in small batches > thousands of tiny prompts.`,
    "- Even if `context` is small, do not use `read`/`grep`/bash to read files; use repl() string/regex search.",
    "- For medium/large repos, delegate to sub-LLMs via the REPL.",
    "",
    "### Choosing Between Tools",
    "| Tool | When |",
    "|------|------|",
    "| `repl({code})` | Need to chunk/delegate `context` to sub-LLMs; need Python scripting; need REPL state across calls |",
    "| `read` / `grep` / bash readers | Blocked for file access; use repl() + pre-loaded `context` instead |",
    "| `zebra-mcp` | Semantic search over the codebase |",
    "| `edit` | Modify an existing file with exact text replacement (native Pi flow, visible to all plugins) |",
    "| `write` | Create a new file (native Pi flow, visible to all plugins) |",
    "| `llm_query` (inside repl) | Extract, summarize, or classify a chunk of text |",
    "| `rlm_query` (inside repl) | Complex sub-task needing iterative reasoning with its own REPL |",
    "| `todo` (inside repl) | Track multi-step progress visibly to the user |",
    "| `stage_edit(path, old, new)` (inside repl) | Sub-agent stages exact edit params; relay STAGED_EDITS to `edit` |",
    "",
    "### Workflow",
    "1. **Plan**: Create todos for the multi-step analysis. Probe `context` — print length, inspect a few entries.",
    "2. **Chunk & Delegate**: Slice `context` into batches, delegate each batch to sub-LLMs via `llm_query_batched`.",
    "3. **Aggregate**: Collect results in Python, pass aggregated results to a final `llm_query` or produce the answer directly.",
    "4. **Finalize**: For file changes, stage them inside repl() via stage_edit(path, old, new), then relay the STAGED_EDITS from the result to `edit`. For analysis tasks, write a normal message.",
    "",
    "### Task-Specific Patterns",
    LARGE_FILE_RULE_NATIVE,
    "- Architecture/code review: chunk relevant files and delegate summaries or review to `llm_query_batched`.",
    "- Bug investigation: use Python string/regex search over `context`; delegate matching files for analysis.",
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
    "ABSOLUTE RESTRICTION: do NOT read files via `read`/`grep`, nor via bash (cat/sed/head/tail/awk/rg — blocked).",
    "bash is for RUNNING things (tests, builds, git); its output is hard-capped at 4K chars. Bulk text must flow through repl() + llm_query_chunked / llm_query_batched.",
    "All file content is pre-loaded in the REPL `context` variable. Use ONLY `repl({code})`.",
    "If sub-LLM credits are exhausted → report the error to the user and stop.",
    "",
    "For file changes, use `edit` (modify existing) or `write` (create new) — these route through",
    "Pi's native tool flow, visible to all plugins with a `+/-` diff preview.",
    "",
    "When repl() returns a STAGED_EDITS block, apply each entry by calling `edit` verbatim:",
    "  edit({ path: entry.path, edits: [{ oldText: entry.oldText, newText: entry.newText }] })",
    "Do not analyze or modify the parameters — relay them exactly as provided by the sub-agent.",
    "",
    nativeReplGlossary(),
  ].join("\n");
}

/** Exported for tests — prompt length without context metadata (which is injected separately). */
export const NATIVE_PROMPT_STATIC = buildNativeSystemPrompt();

/** The one-line context metadata, also reused by the per-turn prompt in headless mode. */
export function buildMetadataLine(meta: PromptMeta, maxPromptChars = DEFAULT_PROMPT_CAP): string {
  const kind = contextKindOf(meta.contextType);
  const contextDesc = kind === "text"
    ? `Your context is a plain string of ${meta.contextChars.toLocaleString()} characters. Use Python slicing to chunk it for sub-LLM delegation.`
    : `Your context is a JSON array of ${meta.contextChars.toLocaleString()} total characters — list[dict] where each dict has keys "path" (str), "content" (str), and "tokens" (int). Use Python list slicing to chunk it into batches for sub-LLM delegation.`;
  const tail = `Each sub-LLM call accepts up to ${maxPromptChars.toLocaleString()} characters (≈${promptCapTokensK(maxPromptChars)}K tokens).`;
  const dist = kind === "files" && meta.contextStats
    ? ` Your context has ${meta.contextStats.files} files; per-file tokens run min ${meta.contextStats.min.toLocaleString()} / median ${meta.contextStats.median.toLocaleString()} / max ${meta.contextStats.max.toLocaleString()} — use this to gauge how many files fit per batch.`
    : "";
  const body = `${contextDesc} ${tail}${dist}`;
  return meta.rootPrompt ? `Answer the following: ${meta.rootPrompt}\n\n${body}` : body;
}
