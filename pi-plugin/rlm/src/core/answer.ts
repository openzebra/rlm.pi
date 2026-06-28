/** Helpers for detecting and formatting the RLM final answer from a turn's REPL results. */

import type { ProposedDiffEdit, ProposedEdit, ReplResult } from "../sandbox/protocol.ts";
import { truncateOutput } from "../text/parsing.ts";

/** First non-null final answer across a turn's executed blocks, or null. */
export function finalAnswerOf(results: readonly ReplResult[]): string | null {
  for (const r of results) if (r.finalAnswer != null) return r.finalAnswer;
  return null;
}

/** Last non-empty answer content set by the REPL, even if answer.ready was not flipped. */
export function latestAnswerContentOf(results: readonly ReplResult[]): string | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const content = results[i]?.answerContent.trim();
    if (content) return content;
  }
  return null;
}

/** Last cumulative legacy anchor proposed-edit set reported by a turn. */
export function collectEdits(results: readonly ReplResult[]): ProposedEdit[] {
  for (let i = results.length - 1; i >= 0; i--) {
    const edits = results[i]?.edits;
    if (edits && edits.length > 0) return [...edits];
  }
  return [];
}

/** Last cumulative diff proposal set reported by a turn. */
export function collectDiffs(results: readonly ReplResult[]): ProposedDiffEdit[] {
  for (let i = results.length - 1; i >= 0; i--) {
    const diffs = results[i]?.diffs;
    if (diffs && diffs.length > 0) return [...diffs];
  }
  return [];
}

/** Parses a ```diff fence from answer text; returns [] if none found. */
export function tryExtractDiff(answer: string): ProposedDiffEdit[] {
  const match = /```diff\n([\s\S]*?)```/.exec(answer);
  if (!match) return [];
  return [{ diff: match[1].trim() }];
}

/** True if any block in the turn raised an exception. Plain stderr does not count. */
export function turnHadError(results: readonly ReplResult[]): boolean {
  return results.some((r) => r.raised);
}

/** Max stdout kept verbatim in history. Larger outputs collapse to a small preview + elision note —
 * the full content persists in REPL variables, never in the root model's history (Algorithm 1:
 * hist ← hist ∥ code ∥ Metadata(stdout)). */
const SMALL_STDOUT_LIMIT = 800;
const STDOUT_PREVIEW_LIMIT = 200;
const STDERR_LIMIT = 8_000;

/** The REPL output fed back to the model as the next user message. */
export function formatReplOutputs(results: readonly ReplResult[]): string {
  if (results.length === 0) {
    return "No ```repl``` block found in your response. Write one to interact with the REPL.";
  }
  const multi = results.length > 1;
  const parts: string[] = [];
  let hadElision = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const head = multi ? `[block ${i + 1}]\n` : "";
    const { text, elided } = formatStdout(r);
    hadElision ||= elided;
    parts.push(`${head}${text}${formatStderr(r)}`);
  }
  const body = parts.join("\n\n");
  // Orientation hint only when the model lost output to elision — otherwise it sees everything.
  if (!hadElision) return body;
  // The REPL namespace is persistent across blocks in a turn, so the last block's varNames reflect
  // every variable created in any earlier block too.
  const varNames = results.at(-1)?.varNames ?? [];
  const hint = varNames.length > 0
    ? `REPL vars: ${varNames.join(", ")}`
    : `No REPL vars yet — assign results to variables before printing large outputs.`;
  return `${body}\n\n${hint}`;
}

/** Stdout ≤ SMALL_STDOUT_LIMIT flows through verbatim; larger output keeps a short head + a note
 * telling the model how to inspect it in slices. Returns whether elision occurred (drives the var-list). */
function formatStdout(r: ReplResult): { text: string; elided: boolean } {
  const out = r.stdout.trim();
  if (!out) return { text: "(no stdout)", elided: false };
  if (out.length <= SMALL_STDOUT_LIMIT) return { text: out, elided: false };
  const note = `[+${out.length - STDOUT_PREVIEW_LIMIT} chars elided — use slices to inspect: print(result[:500])]`;
  return { text: `${out.slice(0, STDOUT_PREVIEW_LIMIT)}\n${note}`, elided: true };
}

function formatStderr(r: ReplResult): string {
  const err = r.stderr.trim();
  return err ? `\n[stderr]\n${truncateOutput(err, STDERR_LIMIT)}` : "";
}
