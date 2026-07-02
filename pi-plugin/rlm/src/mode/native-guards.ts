/**
 * native-guards — keeps bulk file content out of the root model's context in native RLM mode.
 * Layer 1: block file-reading bash commands (steering — the redirect message re-educates).
 * Layer 2: cap tool_result text (guarantee — bulk text physically cannot reach the root model).
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

/** Cap a tool result's text; returns undefined when under the cap (leave the result untouched). */
export function capToolResultText(text: string): string | undefined {
  if (text.length <= TOOL_RESULT_CAP) return undefined;
  return truncateOutput(text, TOOL_RESULT_CAP) + CAP_NOTE;
}
