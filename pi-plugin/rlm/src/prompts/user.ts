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
