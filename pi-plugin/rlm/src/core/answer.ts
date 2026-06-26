/** Helpers for detecting and formatting the RLM final answer from a turn's REPL results. */

import type { ProposedDiffEdit, ProposedEdit, ReplResult } from "../sandbox/protocol.ts";
import { truncateOutput } from "../text/parsing.ts";

/** First non-null final answer across a turn's executed blocks, or null. */
export function finalAnswerOf(results: ReplResult[]): string | null {
  for (const r of results) if (r.finalAnswer != null) return r.finalAnswer;
  return null;
}

/** Last non-empty answer content set by the REPL, even if answer.ready was not flipped. */
export function latestAnswerContentOf(results: ReplResult[]): string | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const content = results[i]?.answerContent.trim();
    if (content) return content;
  }
  return null;
}

/** Last cumulative legacy anchor proposed-edit set reported by a turn. */
export function collectEdits(results: ReplResult[]): ProposedEdit[] {
  for (let i = results.length - 1; i >= 0; i--) {
    const edits = results[i]?.edits;
    if (edits && edits.length > 0) return edits;
  }
  return [];
}

/** Last cumulative unified-diff proposal set reported by a turn. */
export function collectDiffs(results: ReplResult[]): ProposedDiffEdit[] {
  for (let i = results.length - 1; i >= 0; i--) {
    const diffs = results[i]?.diffs;
    if (diffs && diffs.length > 0) return diffs;
  }
  return [];
}

/** True if any block in the turn raised an exception. Plain stderr does not count. */
export function turnHadError(results: ReplResult[]): boolean {
  return results.some((r) => r.raised);
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
