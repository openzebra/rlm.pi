/**
 * native-guards — keeps bulk file content out of the root model's context in native RLM mode.
 * Layer 1: block file-reading bash commands (steering — the redirect message re-educates).
 * Layer 2: cap tool_result text AND repl() stdout (guarantee — bulk text physically cannot
 *          reach the root model).
 * Layer 3: nudge the model when a repl() call printed bulk text without delegating to a sub-LLM.
 * This is token protection, not a security boundary: a determined model can still emit small reads.
 */
import { truncateOutput } from "../text/parsing.ts";

/** Bash commands whose purpose is printing file content / searching — the REPL owns those jobs. */
const READER_COMMANDS: ReadonlySet<string> = Object.freeze(new Set([
  "cat", "sed", "head", "tail", "awk", "grep", "rg", "less", "more",
  "cut", "nl", "tac", "strings", "xxd", "od", "column",
]));

/** Head token of the first pipe segment of each statement (split on ;, &&, ||, newline). */
function statementHeads(command: string): string[] {
  return command
    .split(/(?:\|\||&&|;|\n)/)
    .map((statement) => {
      const firstSegment = statement.split("|", 1)[0] ?? "";
      const tokens = firstSegment.trim().split(/\s+/);
      // Skip env-var prefixes (FOO=bar cmd) and leading wrappers that don't change intent.
      const head = tokens.find((t) => !t.includes("=") && t !== "sudo" && t !== "command" && t !== "env");
      return head === undefined || head.length === 0 ? undefined : head.replace(/^.*\//, "");
    })
    .filter((h): h is string => h !== undefined);
}

/** Extract bash input.command from an unknown Pi tool input shape. */
export function bashCommandFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command: unknown = (input as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

/** True when a statement starts with a file-reading command. */
export function isFileReadingCommand(command: string): boolean {
  return statementHeads(command).some((h) => READER_COMMANDS.has(h));
}

export const BASH_BLOCK_REASON =
  "RLM mode: reading files via bash is blocked — that dumps file content into the root model's " +
  "context. All files are pre-loaded in the REPL `context` variable: use repl({code}) with Python " +
  "string/regex search, and delegate bulk analysis to llm_query / llm_query_batched / " +
  "llm_query_chunked. bash is for RUNNING things (tests, builds, git).";

/** Max chars of tool output forwarded to the root model (≈1K tokens). */
export const TOOL_RESULT_CAP = 4_000;

const CAP_NOTE =
  `\n[RLM: tool output capped at ${TOOL_RESULT_CAP.toLocaleString()} chars to protect the root ` +
  "model's context — route bulk text through repl() + llm_query_chunked / llm_query_batched.]";

const REPL_CAP_NOTE =
  `\n[RLM: repl() stdout capped at ${TOOL_RESULT_CAP.toLocaleString()} chars — printing bulk text ` +
  "is useless. Keep results in REPL variables and delegate semantic reading to llm_query / " +
  "llm_query_batched / llm_query_chunked.]";

/** Shared truncation core. Returns undefined when under the cap (leave the text untouched). */
function capText(text: string, note: string): string | undefined {
  if (text.length <= TOOL_RESULT_CAP) return undefined;
  return truncateOutput(text, TOOL_RESULT_CAP) + note;
}

/** Cap a generic tool result's text (bash / find / ls). */
export function capToolResultText(text: string): string | undefined {
  return capText(text, CAP_NOTE);
}

/** Cap the model-visible portion of a repl() result (stdout / answerContent). */
export function capReplResultText(text: string): string | undefined {
  return capText(text, REPL_CAP_NOTE);
}

/** Stdout size above which a repl() call with zero sub-LLM calls earns a delegation nudge. */
export const NUDGE_STDOUT_CHARS = 2_000;

/**
 * One-line corrective nudge when a repl() call printed bulk text without delegating.
 * Returns undefined when behavior was fine (small output, or a delegation happened).
 * Takes primitives (no RlmSubcall dependency) so the tool layer owns the detection.
 */
export function replDelegationNudge(stdoutChars: number, delegated: boolean): string | undefined {
  if (delegated || stdoutChars <= NUDGE_STDOUT_CHARS) return undefined;
  return (
    `\n[RLM: this repl() printed ${stdoutChars.toLocaleString()} chars with 0 sub-LLM calls — ` +
    "delegate semantic reading via llm_query / llm_query_batched / llm_query_chunked instead of " +
    "reading output yourself.]"
  );
}
