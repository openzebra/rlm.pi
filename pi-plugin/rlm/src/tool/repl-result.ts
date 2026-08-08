/**
 * Model-visible text assembly for a repl() result, plus the advisory diagnostics derived from
 * its sub-calls. Split out of repl-tool.ts: this is pure string/array work with no sandbox,
 * emitter, or TUI dependency, and both halves are asserted directly by test/phase-guards.ts.
 */

import type { RlmSubcall } from "./rlm-details.ts";
import { capReplResultText, replDelegationNudge } from "../mode/native-guards.ts";

/** Model-visible text assembled from a repl() result. */
export interface ReplResultText {
  readonly text: string;
}

/**
 * Assemble the model-visible text for a repl() result: cap stdout, append a zero-subcall
 * delegation nudge when a bulk read went undelegated, and report tasks still running.
 *
 * The pending line is the model's only signal that `spawn()`ed work is outstanding — without
 * it a model that spawned and moved on has no way to know it should still collect.
 *
 * `varNames` covers the opposite failure: a block that stores its results in `answers` and
 * prints nothing reads as a bare "(no output)", so the model concludes the block did nothing
 * and re-runs it — paying twice for the same sub-calls. The headless engine already answers
 * this with the same hint (core/answer.ts); native mode was the only path missing it.
 */
export function buildReplResultText(
  stdout: string,
  finalAnswer: string | undefined,
  subcalls: readonly RlmSubcall[],
  backgroundPending = 0,
  varNames: readonly string[] = [],
): ReplResultText {
  const answerSubmitted = finalAnswer !== undefined;
  const noOutput = !answerSubmitted && !stdout;
  const varsHint = noOutput && varNames.length > 0
    ? ` — the block ran fine and these REPL vars are defined: ${varNames.join(", ")}. `
      + "Do NOT re-run it; read them in the next block."
    : "";
  const rawText = answerSubmitted
    ? `ANSWER_SUBMITTED (${finalAnswer.length} chars) — delivered to user. Do not restate it.`
    : stdout || `(no output)${varsHint}`;
  // Model-visible text is capped; the caller keeps full stdout in `details` for the TUI.
  const cappedText = capReplResultText(rawText) ?? rawText;
  const delegated = subcalls.some((s) => s.kind === "llm" || s.kind === "batch" || s.kind === "rlm");
  const nudge = answerSubmitted ? undefined : replDelegationNudge(rawText.length, delegated);
  const failedBg = subcalls.filter((s) => s.id.startsWith("bg") && s.status === "error").length;
  const pendingLine = backgroundPending > 0
    ? `\n\n[rlm] ${backgroundPending} background task(s) still running — rlm_await_all(tasks) to collect.`
    : "";
  const failedLine = failedBg > 0
    ? `\n[rlm] ${failedBg} background sub-call(s) FAILED — their rlm_await value is an "Error: …" string, not data.`
    : "";
  return { text: cappedText + (nudge ?? "") + pendingLine + failedLine };
}

/** Advisory diagnostics derived from a completed invocation's sub-calls. */
export function collectReplWarnings(subcalls: readonly RlmSubcall[]): readonly string[] | undefined {
  let failed = 0;
  let total = 0;
  for (let i = 0; i < subcalls.length; i++) {
    const call = subcalls[i];
    if (call.status !== "error") continue;
    // A batch subcall stands for many prompts; a single call stands for one.
    failed += call.failedCount ?? 1;
    total += call.totalCount ?? 1;
  }
  if (failed === 0) return undefined;
  return Object.freeze([`${failed}/${total} sub-call(s) failed — results may be incomplete`]);
}
