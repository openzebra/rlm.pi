/**
 * Per-turn user prompts for the headless engine (ported from prompts.py `build_user_prompt`).
 * Native mode does not use these — pi's own loop supplies the turns.
 */

export function buildTurnPrompt(
  iteration: number,
  maxIterations: number,
  gateMessage?: string,
  phaseGuidanceText?: string,
): string {
  const parts: string[] = [];
  if (phaseGuidanceText) parts.push(phaseGuidanceText);
  if (gateMessage) parts.push(gateMessage);
  const prefix = parts.length > 0 ? `${parts.join("\n\n")}\n\n` : "";
  const body = `Turn ${iteration + 1}/${maxIterations}:`;
  if (iteration === 0) {
    return (
      "You have not interacted with the REPL or seen your context yet. Look at the context first; " +
      `do not provide a final answer yet.\n\n${prefix}${body}`
    );
  }
  return `${prefix}${body}`;
}

/** Asked once when the engine runs out of turns without a submitted answer. */
export const FINALIZE_PROMPT =
  "You are out of turns. Provide your best final answer now based on everything you have gathered, " +
  'by setting `answer["content"]` and `answer["ready"] = True` (fenced ```repl```), or as plain text.';
