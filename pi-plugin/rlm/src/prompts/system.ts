/**
 * RLM system prompt (ported from rlm/utils/prompts.py).
 *
 * The root model runs Python by writing fenced ```repl``` blocks (headless engine). The REPL
 * exposes `context`, the sub-LLM functions, and the `answer` dict the model flips to submit.
 */

export interface PromptMeta {
  contextType: string;
  contextChars: number;
  rootPrompt?: string;
  workspaceRoot?: string;
  fsTools?: boolean;
  projectMap?: boolean;
}

export interface SystemPromptOptions {
  orchestrator?: boolean;
  recursion?: boolean;
  edit?: boolean;
}

function howToRunCode(): string {
  return [
    "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns. Only",
    "`print(...)` output (stdout) is returned; a bare expression on the last line is discarded, so",
    "always wrap inspections in `print(...)`.",
  ].join(" ");
}

function replGlossary(recursion: boolean, fsTools: boolean, edit: boolean): string {
  const lines = [
    "Available in the REPL:",
    "- `context`: the important, potentially very long input (usually `str` or `list[str]`).",
    "- `llm_query(prompt: str, model=None) -> str`: a single sub-LLM completion. Use for extraction,",
    "  summarization, or Q&A over a chunk of text.",
    "- `llm_query_batched(prompts: list[str], model=None) -> list[str]`: run several sub-LLM calls",
    "  concurrently; output order matches input order.",
  ];
  if (fsTools) {
    lines.push(
      "- `find(glob=None) -> str`: list project files (optionally filtered by a glob).",
      "- `grep(pattern, glob=None, max_matches=None) -> str`: search file contents. Use to LOCATE code.",
      "- `read_file(path, start=None, end=None) -> str`: read a whole file or a line range.",
      "",
      "You are an ORCHESTRATOR over the repository, not a reader. Do NOT print whole files or read",
      "many files into your own message stream — that pulls the repo back into your context and",
      "defeats the method (the single most common failure mode). Instead:",
      "  1. `grep`/`find` to LOCATE the relevant files.",
      "  2. Pass file CONTENTS straight into a sub-LLM — never into your own output. One file:",
      "       ans = llm_query(f\"{question}\\n\\nFile {path}:\\n{read_file(path)}\")",
      "     Many files (preferred — batch the survivors of your grep/find):",
      "       findings = llm_query_batched([f\"For: {question}\\n\\n{read_file(p)}\" for p in paths])",
      "  3. `print()` ONLY short things: counts, file lists, one-line summaries, or the final answer",
      "     — never raw file bodies. Aggregate sub-LLM findings in Python, then answer.",
      "Read a file directly into your own context only when it is small AND a quick keyword/regex",
      "check would already pin the answer. Glob support is gitignore/ripgrep-style; verify with `read_file`.",
    );
    if (edit) {
      lines.push(
        "- `propose_edit(path, old, new) -> str`: PROPOSE an anchor edit. `old` MUST be copied verbatim",
        "  from `read_file` output and be UNIQUE in the file (extend with surrounding lines if not).",
        "  This does NOT write the file — edits are applied after the run, with the user's approval.",
        "  Workflow: grep/find to LOCATE → read_file to GROUND the exact anchor → generate `new` with",
        "  `llm_query` over the chunk (never verbalize file bodies yourself) → propose_edit. Use loops",
        "  + llm_query_batched to edit many files programmatically; print only short confirmations.",
      );
    }
  }
  if (recursion) {
    lines.push(
      "- `rlm_query(prompt, model=None)` / `rlm_query_batched(prompts, model=None)`: recursive RLM",
      "  sub-calls — each child gets its own REPL to reason iteratively. Use for sub-problems that",
      "  themselves need multi-step reasoning; fall back to `llm_query` for one-shot work.",
    );
  }
  lines.push(
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL.",
    "- `SHOW_EDITS() -> str`: list proposed edits by path and size (no file bodies). Use after",
    "  repeated `propose_edit` calls to avoid duplicates or conflicts.",
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` to the answer text and `answer["ready"] = True`.',
  );
  return lines.join("\n");
}

const ORCHESTRATOR_ADDENDUM = [
  "As an RLM you are an **orchestrator, not a solver**. After you probe `context` and understand the",
  "task, pause and plan: state how the task decomposes into sub-LLM / REPL steps, then execute one step",
  "at a time, printing a small sample of each result to verify before moving on.",
  "",
  "Your own context window is small. Push every long-context operation — reading, summarizing,",
  "classifying, answering sub-questions — into `llm_query` / `llm_query_batched` instead of pulling raw",
  "text into your own message stream. Conversely, if a Python keyword/regex search over `context` would",
  "already pin the answer, just read it directly. Aggregate the small results back in Python.",
  "",
  "Sub-call budget is finite on two axes: (1) per-prompt capacity — keep each sub-prompt modestly sized",
  "(a useful ceiling is ~100K characters), packing a chunk of many items per call; (2) batch fan-out —",
  "keep batches to roughly ~20 prompts. Fat prompts in small batches beat thousands of tiny prompts.",
  "If the workload exceeds both at once, filter aggressively in Python first, then batch the survivors.",
  "",
  "Reserve your own tokens for high-level decisions: what to ask next, how to combine sub-LM outputs,",
  "when to finalize. Delegate everything else. Do not submit a final answer before inspecting `context`.",
].join("\n");

const INTRO = [
  "You are a Recursive Language Model (RLM): a language model with a prompt and a very important",
  "context stored in a Python REPL. You interact with the REPL turn-by-turn until you have an answer.",
].join(" ");

/** Build the full RLM system prompt. */
export function buildRlmSystemPrompt(meta: PromptMeta, opts: SystemPromptOptions = {}): string {
  const recursion = opts.recursion ?? false;
  const parts = [
    INTRO,
    "",
    howToRunCode(),
    "",
    replGlossary(recursion, meta.fsTools ?? false, opts.edit ?? false),
    "",
    "REPL outputs over ~20K characters are truncated, so for long payloads (including `read_file`",
    "output) slice them and pass the slices through `llm_query` rather than printing them whole.",
    "",
    "Start by probing `context` (print a few lines, count items). Then build up an answer to the query.",
  ];
  if (opts.orchestrator ?? true) {
    parts.push("", ORCHESTRATOR_ADDENDUM);
  }
  parts.push("", buildMetadataLine(meta));
  return parts.join("\n");
}

/** The one-line context metadata, also reused by the per-turn prompt in headless mode. */
export function buildMetadataLine(meta: PromptMeta): string {
  const contextDesc = meta.projectMap && meta.workspaceRoot
    ? `Context is a project map (file list) for workspace ${meta.workspaceRoot}. Locate files with grep/find, but read file CONTENTS only through llm_query/llm_query_batched — do not pull file bodies into your own context.`
    : `Your context is a ${meta.contextType} of ${meta.contextChars.toLocaleString()} total characters.`;
  const body = `${contextDesc} Each sub-LLM call can handle roughly ~100k tokens at once.`;
  return meta.rootPrompt ? `Answer the following: ${meta.rootPrompt}\n\n${body}` : body;
}
