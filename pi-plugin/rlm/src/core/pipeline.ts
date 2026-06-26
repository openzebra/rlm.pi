/**
 * RLM pipeline phase state machine.
 *
 * Hard-gated phases: research → blueprint → implement → validate.
 * The root RLM calls advance_phase() to move forward; the engine enforces
 * forward-only progression, persists phase rows, and re-prompts when a
 * phase stalls for too many turns.
 */

export type Phase = "research" | "blueprint" | "implement" | "validate";

export const PHASES = Object.freeze([
  "research",
  "blueprint",
  "implement",
  "validate",
] as const satisfies readonly Phase[]);

export interface PhaseState {
  readonly current: Phase;
  readonly advancedAt: number; // turn number when this phase was entered (0-based)
  readonly summary?: string;
}

export interface AdvancePhaseResult {
  readonly ok: true;
  readonly phase: Phase;
}

export interface AdvancePhaseFailure {
  readonly ok: false;
  readonly error: string;
  readonly phase: Phase;
}

export type AdvancePhaseOutcome = AdvancePhaseResult | AdvancePhaseFailure;

/** PHASE_GATE_TURNS: if the model stays in one phase for this many turns, the engine re-prompts. */
export const PHASE_GATE_TURNS = 4;

/** Validate a phase transition. Only forward progression is allowed. */
export function advancePhase(
  current: Phase | undefined,
  target: string,
): AdvancePhaseOutcome {
  if (!PHASES.includes(target as Phase)) {
    return {
      ok: false,
      error: `unknown phase '${target}'; valid phases: ${PHASES.join(", ")}`,
      phase: current ?? "research",
    };
  }
  const from = current ?? "research";
  const currentIdx = PHASES.indexOf(from);
  const targetIdx = PHASES.indexOf(target as Phase);
  if (targetIdx <= currentIdx) {
    return {
      ok: false,
      error: `cannot move backward from '${from}' to '${target}'`,
      phase: from,
    };
  }
  return { ok: true, phase: target as Phase };
}

/** Return the current phase (defaults to "research" if undefined). */
export function currentPhase(state: PhaseState | undefined): Phase {
  return state?.current ?? "research";
}

/** Return the number of turns spent in the current phase. */
export function turnsInPhase(state: PhaseState | undefined, completedTurns: number): number {
  return state ? completedTurns - state.advancedAt : completedTurns;
}

/** Produce a re-prompt message when the model stalls in a phase for too long. */
export function phaseGatePrompt(
  state: PhaseState | undefined,
  completedTurns: number,
): string | undefined {
  const turns = turnsInPhase(state, completedTurns);
  const phase = currentPhase(state);
  if (turns >= PHASE_GATE_TURNS) {
    const next = nextPhase(phase);
    const hint = next
      ? ` Consider calling advance_phase("${next}") if your ${phase} work is complete.`
      : "";
    return [
      `You have spent ${turns} turns in the '${phase}' phase.`,
      `If the ${phase} phase is complete, advance to the next phase.${hint}`,
    ].join(" ");
  }
  return undefined;
}

/** Return the next phase, or undefined if at the terminal phase. */
export function nextPhase(current: Phase): Phase | undefined {
  const idx = PHASES.indexOf(current);
  return idx >= 0 && idx < PHASES.length - 1 ? PHASES[idx + 1] : undefined;
}
