/**
 * RLM system prompt (ported from rlm/utils/prompts.py).
 *
 * The root model runs Python by writing fenced ```repl``` blocks; the engine parses them, executes
 * them in the persistent sandbox, and feeds back stdout. The REPL exposes `context`, the sub-LLM
 * functions, and the `answer` dict the model flips to submit.
 */

export interface PromptMeta {
  contextType: string;
  contextChars: number;
  rootPrompt?: string;
}

export interface SystemPromptOptions {
  orchestrator?: boolean;
  recursion?: boolean;
}

const HOW_TO_RUN_CODE = [
  "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns. Only",
  "`print(...)` output (stdout) is returned; a bare expression on the last line is discarded, so",
  "always wrap inspections in `print(...)`.",
].join(" ");

function replGlossary(recursion: boolean): string {
  const lines = [
    "Available in the REPL:",
    "- `context`: the important, potentially very long input (usually `str` or `list[str]`).",
    "- `llm_query(prompt: str, model=None) -> str`: a single sub-LLM completion. Use for extraction,",
    "  summarization, or Q&A over a chunk of text.",
    "- `llm_query_batched(prompts: list[str], model=None) -> list[str]`: run several sub-LLM calls",
    "  concurrently; output order matches input order.",
  ];
  if (recursion) {
    lines.push(
      "- `rlm_query(prompt, model=None)` / `rlm_query_batched(prompts, model=None)`: recursive RLM",
      "  sub-calls — each child gets its own REPL to reason iteratively. Use for sub-problems that",
      "  themselves need multi-step reasoning; fall back to `llm_query` for one-shot work.",
    );
  }
  lines.push(
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL.",
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
    HOW_TO_RUN_CODE,
    "",
    replGlossary(recursion),
    "",
    "REPL outputs over ~20K characters are truncated, so for long payloads slice `context` and pass the",
    "slices through `llm_query` rather than printing them whole.",
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
  const body =
    `Your context is a ${meta.contextType} of ${meta.contextChars.toLocaleString()} total characters. ` +
    "Each sub-LLM call can handle roughly ~100k tokens at once.";
  return meta.rootPrompt ? `Answer the following: ${meta.rootPrompt}\n\n${body}` : body;
}
