/**
 * RLM system prompt (ported from rlm/utils/prompts.py).
 *
 * The root model runs Python by writing fenced ```repl``` blocks (headless engine). The REPL
 * exposes `context`, the sub-LLM functions, and the `answer` dict the model flips to submit.
 */
import type { ContextSizeStats } from "../text/tokens.ts";
import {
  contextKindOf,
  DEFAULT_PROMPT_CAP,
  ENV_TIPS,
  howToRunCode,
  LARGE_FILE_RULE_LINES,
  promptCapTokensK,
  replGlossary,
} from "./glossary.ts";

export { contextKindOf, type ContextKind } from "./glossary.ts";

export interface PromptMeta {
  readonly contextType: string;
  readonly contextChars: number;
  readonly contextStats?: ContextSizeStats;
  readonly rootPrompt?: string;
}

export interface SystemPromptOptions {
  readonly orchestrator?: boolean;
  readonly recursion?: boolean;
  readonly maxPromptChars?: number;
  readonly contextLoader?: boolean;
  /** depth > 0 — this run is an rlm_query child and its `context` is the parent's world. */
  readonly child?: boolean;
}

function orchestratorAddendum(maxPromptChars: number): string {
  return [
    "As an RLM you are an **orchestrator, not a solver**. After you probe `context` and understand the",
    "task, pause and plan: state how the task decomposes into sub-LLM / REPL steps, then execute one step",
    "at a time, printing a small sample of each result to verify before moving on.",
    "",
    "Your own context window is small. Push every long-context operation — reading, summarizing,",
    "classifying, answering sub-questions — into `llm_query` / `llm_batch` instead of pulling raw",
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
    replGlossary(
      kind, recursion, opts.contextLoader ?? false, opts.child ?? false,
    ),
    "",
    "REPL stdout over ~800 characters is truncated to a short excerpt — large results stay in your",
    "REPL variables as buffers. Re-print only the slice you need (e.g. `print(result[:500])`); never",
    "dump a whole sub-LLM result. The full content persists across turns in REPL variables (call `SHOW_VARS()`).",
    "",
    "Start by probing `context` (print a few lines, count items). Then build up an answer to the query.",
  ];
  if (opts.orchestrator ?? true) {
    // Two counterweights, both required (paper App. B): the addendum bounds OVER-recursion
    // (batching/cost), ENV_TIPS bounds UNDER-recursion (solving it yourself).
    parts.push("", orchestratorAddendum(maxPromptChars), "", ENV_TIPS);
  }
  if (kind === "files") {
    parts.push("", LARGE_FILE_RULE_LINES.join("\n"));
  }
  parts.push("", buildMetadataLine(meta, maxPromptChars));
  return parts.join("\n");
}

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
