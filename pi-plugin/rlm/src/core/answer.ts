/** Helpers for detecting and formatting the RLM final answer from a turn's REPL results. */

import type { ReplResult } from "../sandbox/protocol.ts";
import { truncateOutput } from "../text/parsing.ts";

/** First non-null final answer across a turn's executed blocks, or null. */
export function finalAnswerOf(results: ReplResult[]): string | null {
  for (const r of results) if (r.finalAnswer != null) return r.finalAnswer;
  return null;
}

/** True if any block in the turn raised an error (stderr present). */
export function turnHadError(results: ReplResult[]): boolean {
  return results.some((r) => r.stderr.trim().length > 0);
}

/** The REPL output fed back to the model as the next user message. */
export function formatReplOutputs(results: ReplResult[]): string {
  if (results.length === 0) {
    return "No ```repl``` block found in your response. Write one to interact with the REPL.";
  }
  return results
    .map((r, i) => {
      const head = results.length > 1 ? `[block ${i + 1}]\n` : "";
      const out = r.stdout.trim() ? truncateOutput(r.stdout) : "(no stdout)";
      const err = r.stderr.trim() ? `\n[stderr]\n${truncateOutput(r.stderr, 8000)}` : "";
      return `${head}${out}${err}`;
    })
    .join("\n\n");
}
