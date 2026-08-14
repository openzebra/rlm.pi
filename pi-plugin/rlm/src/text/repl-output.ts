/**
 * Shared REPL output formatting used by headless history and native repl() tool results.
 * Lives in text/ so tool/ does not import from core/.
 */

import { truncateOutput } from "./parsing.ts";

/** Max stderr kept in model-visible REPL output (headless history and native tool_result). */
export const STDERR_LIMIT = 8_000;

/** Prefix stderr so the model can tell prints from exceptions. Empty when stderr is blank. */
export function formatReplStderr(stderr: string, limit = STDERR_LIMIT): string {
  const err = stderr.trim();
  return err ? `\n[stderr]\n${truncateOutput(err, limit)}` : "";
}
