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
  /** The recursion depth of this run (0 = root, 1 = first child, etc.). */
  readonly depth?: number;
}

function orchestratorAddendum(maxPromptChars: number): string {
  return [
    "As an RLM you are an **orchestrator, not a solver**. Probe `context`, plan decomposition, then",
    "fan out — do not solve multi-step module work yourself in a long chain of thought.",
    "",
    "<contract> llm_query / llm_batch / map_files / rlm_query / rlm_batch return Task (not the answer).",
    "Only await_task returns content. Fire independent Tasks first, free search, then await_task.",
    "Do not await after every independent spawn.</contract>",
    "",
    "<routing> one-shot facts → llm_query/llm_batch/map_files; one multi-step study → rlm_query;",
    "≥2 independent multi-step areas → rlm_batch (prefer over serial rlm_query). NEVER print file",
    "bodies into your own stream when a Task tool can read them.</routing>",
    "",
    "Your own context window is small. Push long-context work into sub-calls. If free search/grep",
    "already pins a tiny fact, use that. Aggregate small results in Python / `answers`.",
    "",
    `Sub-call budget: (1) per-prompt < ${maxPromptChars.toLocaleString()} chars (≈${promptCapTokensK(maxPromptChars)}K tok);`,
    "(2) ~20 prompts per llm_batch. Fat prompts in small batches beat thousands of tiny prompts.",
    "Filter in Python first when both axes overflow.",
    "",
    "Reserve your tokens for planning, combining, and finalizing. Do not finalize before inspecting `context`.",
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
  ];
  if ((opts.depth ?? 0) > 0) {
    parts.push(
      "",
      `**Recursion depth: ${opts.depth}.** You are a sub-RLM — focus narrowly on your assigned`,
      "task. Delegate (rlm_query/rlm_batch) only if the task itself must decompose further.",
    );
  }
  parts.push(
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
  );
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
  return meta.rootPrompt ? `<task>${meta.rootPrompt}</task>\n\n${body}` : body;
}
