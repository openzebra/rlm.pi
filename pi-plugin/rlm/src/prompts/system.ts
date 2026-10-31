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
  envTips,
  howToRunCode,
  LARGE_FILE_RULE_LINES,
  promptCapTokensK,
  replGlossary,
} from "./glossary.ts";

export { contextKindOf, type ContextKind } from "./glossary.ts";

interface PromptMeta {
  readonly contextType: string;
  readonly contextChars: number;
  readonly contextStats?: ContextSizeStats;
  readonly rootPrompt?: string;
  /** SKILL.state Ξ (Workstream C): verified project facts from prior sessions. Per-run
   *  argument only — never baked into any module-load snapshot. */
  readonly skillBlock?: string;
}

interface SystemPromptOptions {
  readonly orchestrator?: boolean;
  readonly recursion?: boolean;
  readonly maxPromptChars?: number;
  /** Per-print verbatim stdout budget (chars) — mirrors STDOUT_VERBATIM_CHARS_DEFAULT
   *  (limits.ts); the engine always passes the config value, so drift never manifests. */
  readonly stdoutVerbatimChars?: number;
  readonly contextLoader?: boolean;
  /** depth > 0 — this run is an rlm_query child and its `context` is the parent's world. */
  readonly child?: boolean;
  /** The recursion depth of this run (0 = root, 1 = first child, etc.). */
  readonly depth?: number;
  /** v5 doctrine: the child sandbox has the delegation-only surface (no retrieval tools). */
  readonly delegation?: boolean;
}

function orchestratorAddendum(maxPromptChars: number, delegation: boolean): string {
  return [
    "As an RLM you are an **orchestrator, not a solver**. Probe `context`, plan decomposition, then fan out.",
    `<contract> Heavy calls return Task; only await_task returns content. Fire independent Tasks first, ${delegation ? "slice `context`" : "free search"}, then await_task.</contract>`,
    "<routing> one-shot extracts → llm_query/llm_batch/map_files; multi-step study → rlm_query; ≥2 areas → rlm_batch. Never print raw file bodies.</routing>",
    `Budget: < ${maxPromptChars.toLocaleString()} chars (≈${promptCapTokensK(maxPromptChars)}K tok) per prompt; ~20 prompts/llm_batch.`,
    "Fan out per-file/chunk reading via `map_files` / `llm_batch` instead of dumping files in Python loops. `llm_query`/`llm_batch` are non-thinking extractors: spell out strict criteria in their prompt (`index | label | 5-word reason`) and audit borderline items yourself for exact counts.",
  ].join("\n");
}

const INTRO = [
  "You are a Recursive Language Model (RLM): a language model with a prompt and a very important",
  "context stored in a Python REPL. You interact with the REPL turn-by-turn until you have an answer.",
].join(" ");

/** Fallback for the per-print stdout cap — mirrors STDOUT_VERBATIM_CHARS_DEFAULT (limits.ts).
 *  The engine always passes the config value, so drift between the two never manifests. */
const DEFAULT_STDOUT_CAP = 4_000;

/** Build the full RLM system prompt. */
export function buildRlmSystemPrompt(meta: PromptMeta, opts: SystemPromptOptions = {}): string {
  const recursion = opts.recursion ?? false;
  const kind = contextKindOf(meta.contextType);
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_PROMPT_CAP;
  const stdoutCap = (opts.stdoutVerbatimChars ?? DEFAULT_STDOUT_CAP).toLocaleString();
  const parts = [
    INTRO,
  ];
  if ((opts.depth ?? 0) > 0) {
    parts.push(
      "",
      `**Recursion depth: ${opts.depth}.** You are a sub-RLM — focus narrowly on your assigned`,
      "task. Delegate (rlm_query/rlm_batch) only if the task itself must decompose further.",
    );
    if (opts.delegation ?? false) {
      parts.push(
        "",
        "**REPL API (delegation surface):** no `search`/`grep_context`/`outline` — slice `context` in Python and delegate slices.",
      );
    }
  }
  parts.push(
    "",
    howToRunCode(),
    "",
    replGlossary(
      kind, recursion, opts.contextLoader ?? false, opts.child ?? false, opts.delegation ?? false,
    ),
    "",
    `Per-print stdout cap: ${stdoutCap} chars (over-cap keeps head+tail; full values stay in REPL vars — \`SHOW_VARS()\`, \`print(v[a:b])\`).`,
  );
  if (opts.orchestrator ?? true) {
    // Two counterweights, both required (paper App. B): the addendum bounds OVER-recursion
    // (batching/cost), envTips() bounds UNDER-recursion (solving it yourself).
    parts.push("", orchestratorAddendum(maxPromptChars, opts.delegation ?? false), "", envTips(opts.delegation ?? false));
  }
  if (kind === "files") {
    parts.push("", LARGE_FILE_RULE_LINES.join("\n"));
  }
  // Ξ (Workstream C): lands BEFORE the metadata line so the task header stays last — the model
  // reads it freshest. Verified-fact grounding precedes the fresh task statement.
  if (meta.skillBlock !== undefined && meta.skillBlock !== "") {
    parts.push("", meta.skillBlock);
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
