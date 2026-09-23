/** Helpers for detecting and formatting the RLM final answer from a turn's REPL results. */

import type { ReplResult } from "../sandbox/protocol.ts";
import { STDOUT_VERBATIM_CHARS_DEFAULT } from "./limits.ts";
import { stdoutBulkMark, stdoutElidedMark } from "../prompts/glossary.ts";
import { formatReplStderr } from "../text/repl-output.ts";
import { truncateOutput } from "../text/parsing.ts";

/** First non-blank final answer across a turn's executed blocks, or null. A blank capture counts
 *  as absent (H2): an empty `answer.ready` flip must never terminate a run with "". */
export function finalAnswerOf(results: readonly ReplResult[]): string | null {
  for (const r of results) {
    if (r.finalAnswer != null && r.finalAnswer.trim() !== "") return r.finalAnswer;
  }
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

/** Cap for the recovered-stdout fallback (P2 §3.4) — it rides `RlmResult`, not history. */
const LAST_STDOUT_CAP = 4_000;

/** Last non-empty stdout across a turn's blocks, capped. P2 §3.4: a run that ends without an
 *  `answer[...]` frame still printed its winning value, and re-running the whole task to get it
 *  is a waste (and non-deterministic). The bench recovers from here and marks the row
 *  `recovered: true`; the engine itself never treats stdout as an answer. */
export function latestStdoutOf(results: readonly ReplResult[]): string {
  for (let i = results.length - 1; i >= 0; i--) {
    const out = results[i]?.stdout.trim();
    if (out) return out.length > LAST_STDOUT_CAP ? out.slice(-LAST_STDOUT_CAP) : out;
  }
  return "";
}

/** True if any block in the turn raised an exception. Plain stderr does not count. */
export function turnHadError(results: readonly ReplResult[]): boolean {
  return results.some((r) => r.raised);
}

/** Model-visible stdout budget for a headless turn. Per-print fairness (the read-loop fix):
 *  every print() passes through verbatim up to `verbatimChars` — one print never steals from
 *  another — and a block whose kept total exceeds the derived per-block budget (4× verbatim)
 *  collapses its middle prints. Bulk output still collapses (Algorithm 1: hist ← hist ∥ code ∥
 *  Metadata(stdout) keeps only bounded stdout metadata in history — the full content persists
 *  in REPL variables, never in the root model's history). */
export interface ReplFormatOpts {
  /** Per-print verbatim stdout budget (chars); a block's total budget is 4× this. */
  readonly verbatimChars?: number;
}

/** The REPL output fed back to the model as the next user message. Prefixed `REPL stdout:`
 *  (v5 parity, audit C4): `distillTrajectory` keys on this needle to harvest the working
 *  set for a budget-capped continuation — without it a hard-cap chain starts blind. */
export function formatReplOutputs(results: readonly ReplResult[], skippedBlocks = 0, opts: ReplFormatOpts = {}): string {
  if (results.length === 0) {
    return "No ```repl``` block found in your response. Write one to interact with the REPL.";
  }
  const verbatim = Math.max(200, Math.floor(opts.verbatimChars ?? STDOUT_VERBATIM_CHARS_DEFAULT));
  const blockMax = 4 * verbatim;
  const multi = results.length > 1;
  const parts = new Array<string>(results.length);
  let hadElision = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const head = multi ? `[block ${i + 1}]\n` : "";
    const { text, elided } = formatStdout(r, verbatim, blockMax);
    hadElision ||= elided;
    // Nudges are host hints, never program output — appended verbatim AFTER elision so
    // they can never be collapsed away.
    const nudges = r.nudges.length > 0 ? `\n${r.nudges.join("\n")}` : "";
    parts[i] = `${head}${text}${nudges}${formatReplStderr(r.stderr)}`;
  }
  const body = parts.join("\n\n");
  const skipNote = skippedBlocks > 0
    ? `\n\n[${skippedBlocks} later \`\`\`repl\`\`\` block(s) skipped because an earlier block raised — fix and re-run them]`
    : "";
  // Orientation hint only when the model lost output to elision — otherwise it sees everything.
  if (!hadElision) return `REPL stdout:\n${body}${skipNote}`;
  // The REPL namespace is persistent across blocks in a turn, so the last block's varNames reflect
  // every variable created in any earlier block too.
  const varNames = results.at(-1)?.varNames ?? [];
  const hint = varNames.length > 0
    ? `REPL vars: ${varNames.join(", ")}`
    : `No REPL vars yet — assign results to variables before printing large outputs.`;
  return `REPL stdout:\n${body}${skipNote}\n\n${hint}`;
}

/** Per-print fair stdout formatting. Segments are the worker's print boundaries; each passes
 *  through verbatim up to `verbatim` chars (larger keeps head+tail + an elision note — the
 *  head/tail math is `truncateOutput`, the one implementation). When the block's kept total
 *  exceeds `blockMax`, middle prints collapse to one bulk note (first and last survive).
 *  Marks are advisory: a worker without them degrades to one legacy segment. Returns whether
 *  elision occurred (drives the var-list). */
function formatStdout(r: ReplResult, verbatim: number, blockMax: number): { text: string; elided: boolean } {
  const out = r.stdout.trim();
  if (!out) return { text: "(no stdout)", elided: false };
  const segments = segmentStdout(out, r.stdoutMarks);
  const parts = new Array<string>(segments.length);
  const lens = new Array<number>(segments.length);
  let elided = false;
  let kept = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length <= verbatim) {
      parts[i] = seg;
      lens[i] = seg.length;
      kept += seg.length;
    } else {
      parts[i] = truncateOutput(seg, verbatim, stdoutElidedMark(seg.length - verbatim, verbatim));
      lens[i] = verbatim;
      kept += verbatim;
      elided = true;
    }
  }
  if (kept <= blockMax) return { text: parts.join("\n"), elided };
  // Middle-collapse (mirror of elideOldToolPayloads' head/working-tail shape): leading and
  // trailing prints survive, the middle run becomes one note. lens[i] ≤ verbatim <
  // 0.5·blockMax, so both walks always place at least one segment — no empty-output edge.
  const halfMax = Math.floor(blockMax * 0.5);
  const tailMax = Math.floor(blockMax * 0.3);
  let headEnd = 0;
  let acc = 0;
  while (headEnd < parts.length && acc + lens[headEnd] <= halfMax) {
    acc += lens[headEnd];
    headEnd++;
  }
  let tailStart = parts.length;
  acc = 0;
  while (tailStart > headEnd && acc + lens[tailStart - 1] <= tailMax) {
    acc += lens[tailStart - 1];
    tailStart--;
  }
  const collapsed = tailStart - headEnd;
  const keptParts: string[] = [];
  for (let i = 0; i < headEnd; i++) keptParts.push(parts[i]);
  if (collapsed > 0) keptParts.push(stdoutBulkMark(collapsed, blockMax));
  for (let i = tailStart; i < parts.length; i++) keptParts.push(parts[i]);
  return { text: keptParts.join("\n"), elided: true };
}

/** Split stdout into per-print segments at the worker's captured-stdout offsets. Marks are
 *  advisory: deduped, bounds-checked, ascending; empty segments (a file=-redirected print
 *  appends the unadvanced tell() of the captured buffer) are dropped; no marks ⇒ one legacy
 *  segment (an old worker keeps working). */
function segmentStdout(out: string, marks: readonly number[]): readonly string[] {
  const sorted = [...new Set(marks)]
    .filter((m) => Number.isFinite(m) && m > 0 && m < out.length)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [out];
  const segments: string[] = [];
  let prev = 0;
  for (const m of sorted) {
    const seg = out.slice(prev, m);
    if (seg.length > 0) segments.push(seg);
    prev = m;
  }
  const last = out.slice(prev);
  if (last.length > 0) segments.push(last);
  return segments;
}

