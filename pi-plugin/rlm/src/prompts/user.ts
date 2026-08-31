/**
 * Per-turn user prompts for the headless engine (ported from prompts.py `build_user_prompt`).
 * Native mode does not use these — pi's own loop supplies the turns.
 */

export function buildTurnPrompt(
  iteration: number,
  maxIterations: number,
  gateMessage?: string,
): string {
  const prefix = gateMessage ? `${gateMessage}\n\n` : "";
  const body = `Turn ${iteration + 1}/${maxIterations}:`;
  if (iteration === 0) {
    return (
      "You have not interacted with the REPL or seen your context yet. Look at the context first; " +
      `do not provide a final answer yet.\n\n${prefix}${body}`
    );
  }
  return `${prefix}${body}`;
}

/** Asked once when the engine runs out of turns without a submitted answer. Same finalize
 *  dialect as the budget wrap-up note (audit M6): answer-ready first, plain text only as an
 *  explicit fallback the engine still accepts. */
export const FINALIZE_PROMPT =
  "You are out of turns. Finalize NOW: set `answer[\"content\"]` and `answer[\"ready\"] = True` " +
    "(fenced ```repl```) with your best final answer from everything you have gathered. " +
    "Only if the REPL is unavailable, answer as plain text.";

/** One-shot retrieval-discipline nudge (the engine owns the when — see core/engine.ts). The
 *  context is external by design, so a model that never calls search()/grep_context() is
 *  guessing from padding vocabulary; after two retrieval-free turns it gets this once. */
export const RETRIEVAL_NUDGE =
  "[coach] You have not inspected the external context yet — it is NOT included in this " +
  "chat, and guessing is useless: the text is padding. On THIS turn, call search(\"...\") " +
  "or grep_context(\"...\") inside a ```repl block before answering.";

/** One-shot budget hint (engine-owned, turn 0 only): reasoning tokens share the completion
 *  budget with the answer, mirroring the bench's doubling rule — a reasoning root with a
 *  small output cap risks truncated thought. Advisory only; never fatal. */
export const REASONING_BUDGET_HINT =
  "[budget] Reasoning is on while the root output cap is below 8192 tokens: thinking shares " +
  "the completion budget with the answer, so long thought may be cut off mid-reasoning. " +
  "Keep thought concise, or raise rootSampling.maxTokens.";
