/**
 * RLM pipeline stage graph — data-driven transitions with deterministic gates.
 *
 * Stages: research → blueprint → implement → validate.
 * The root RLM writes artifacts via save_artifact(); advance_phase() is gated by
 * TypeScript floors (never LLM judgment). Validate routes on measured
 * blockers_count with a bounded corrective loop back to blueprint.
 */
import {
  checkStatusReady,
  type GateResult,
  planPhaseRecords,
  type PlanGateData,
  type ValidationGateData,
  validationRecord,
  verifyCitations,
} from "./gates.ts";

export type Phase = "research" | "blueprint" | "implement" | "validate";

export const PHASES = Object.freeze([
  "research",
  "blueprint",
  "implement",
  "validate",
] as const satisfies readonly Phase[]);

/** Kind string the model passes to save_artifact(kind, content). */
export type ArtifactKind = "research" | "plan" | "validation";

/** Structured data a stage gate extracts from its artifact (what edges route on). */
export type StageGateData =
  | { readonly kind: "research" }
  | { readonly kind: "plan"; readonly plan: PlanGateData }
  | { readonly kind: "validation"; readonly validation: ValidationGateData }
  | { readonly kind: "side-effect" };

export interface StageDef {
  readonly phase: Phase;
  /** Subdir under .rlm/artifacts/ ("" = side-effect stage, no artifact). */
  readonly artifactDir: string;
  /** save_artifact kind, or "" when the stage produces no artifact. */
  readonly artifactKind: ArtifactKind | "";
  /** Deterministic floor run on the artifact BEFORE leaving this stage. */
  readonly gate: (content: string, path: string, cwd: string) => GateResult<StageGateData>;
}

/** Compose floors: status: ready → citations → stage-specific contract. */
const researchGate: StageDef["gate"] = (content, path, cwd) => {
  const status = checkStatusReady(content, path);
  if (!status.ok) return status;
  const cites = verifyCitations(content, cwd);
  if (!cites.ok) return cites;
  return { ok: true, value: { kind: "research" } };
};

const blueprintGate: StageDef["gate"] = (content, path, cwd) => {
  const status = checkStatusReady(content, path);
  if (!status.ok) return status;
  const cites = verifyCitations(content, cwd);
  if (!cites.ok) return cites;
  const plan = planPhaseRecords(content, path);
  if (!plan.ok) return plan;
  return { ok: true, value: { kind: "plan", plan: plan.value } };
};

const validateGate: StageDef["gate"] = (content, path) => {
  const status = checkStatusReady(content, path);
  if (!status.ok) return status;
  const rec = validationRecord(content, path);
  if (!rec.ok) return rec;
  return { ok: true, value: { kind: "validation", validation: rec.value } };
};

/** Single source of truth for gates, artifact dirs/kinds, and routing. */
export const STAGES: Readonly<Record<Phase, StageDef>> = Object.freeze({
  research: { phase: "research", artifactDir: "research", artifactKind: "research", gate: researchGate },
  blueprint: { phase: "blueprint", artifactDir: "plans", artifactKind: "plan", gate: blueprintGate },
  // implement is a side-effect stage; exit is engine-driven (serial fanout).
  implement: {
    phase: "implement",
    artifactDir: "",
    artifactKind: "",
    gate: (): GateResult<StageGateData> => ({ ok: true, value: { kind: "side-effect" } }),
  },
  validate: { phase: "validate", artifactDir: "validations", artifactKind: "validation", gate: validateGate },
});

/** Lookup stage by save_artifact kind — single map derived from STAGES (DRY). */
const STAGE_BY_KIND: Readonly<Partial<Record<ArtifactKind, StageDef>>> = Object.freeze(
  (Object.values(STAGES) as readonly StageDef[]).reduce<Partial<Record<ArtifactKind, StageDef>>>((acc, stage) => {
    if (stage.artifactKind !== "") acc[stage.artifactKind] = stage;
    return acc;
  }, {}),
);

export function stageForArtifactKind(kind: string): StageDef | undefined {
  if (kind === "research" || kind === "plan" || kind === "validation") {
    return STAGE_BY_KIND[kind];
  }
  return undefined;
}

export interface PhaseState {
  readonly current: Phase;
  readonly advancedAt: number;
  readonly summary?: string;
  /** Artifact each completed stage produced — the named channels. */
  readonly artifacts: Readonly<Partial<Record<Phase, string>>>;
  /** Corrective validate→blueprint re-entries taken so far. */
  readonly backwardJumps: number;
}

export function initialPhaseState(advancedAt = 0): PhaseState {
  return { current: "research", advancedAt, artifacts: Object.freeze({}), backwardJumps: 0 };
}

export type RouteDecision =
  | { readonly kind: "done" }
  | { readonly kind: "loop-back"; readonly next: "blueprint" }
  | { readonly kind: "halt"; readonly reason: string };

/**
 * Route out of `validate` on MEASURED gate data: blockers_count === 0 → done;
 * blockers_count > 0 → loop back to blueprint, bounded by maxBackwardJumps.
 */
export function routeAfterValidate(
  data: ValidationGateData,
  backwardJumps: number,
  maxBackwardJumps: number,
): RouteDecision {
  if (data.blockersCount === 0) return { kind: "done" };
  if (backwardJumps >= maxBackwardJumps) {
    return {
      kind: "halt",
      reason: `validation reports ${data.blockersCount} blocker(s) after ${backwardJumps} corrective pass(es) — backward-jump limit (${maxBackwardJumps}) reached; surfacing the validation report as the final answer`,
    };
  }
  return { kind: "loop-back", next: "blueprint" };
}

/** Forward transitions only; corrective loop-back is ENGINE-initiated via routeAfterValidate. */
export function nextForward(current: Phase): Phase | undefined {
  const idx = PHASES.indexOf(current);
  return idx >= 0 && idx < PHASES.length - 1 ? PHASES[idx + 1] : undefined;
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

/**
 * Pure order check: only the immediate next phase is allowed.
 * Artifact gates are applied by the engine after this returns ok.
 */
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
  const expected = nextForward(from);
  if (expected === undefined) {
    return {
      ok: false,
      error: `'${from}' is the terminal phase; finalize via answer["ready"] = True after saving the validation artifact`,
      phase: from,
    };
  }
  if (target !== expected) {
    return {
      ok: false,
      error: `cannot advance from '${from}' to '${target}' — the next phase is '${expected}'`,
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

/** PHASE_GATE_TURNS: if the model stays in one phase for this many turns, the engine re-prompts. */
export const PHASE_GATE_TURNS = 4;

/** Produce a re-prompt message when the model stalls in a phase for too long. */
export function phaseGatePrompt(
  state: PhaseState | undefined,
  completedTurns: number,
): string | undefined {
  const turns = turnsInPhase(state, completedTurns);
  const phase = currentPhase(state);
  if (turns >= PHASE_GATE_TURNS && turns % PHASE_GATE_TURNS === 0) {
    const next = nextForward(phase);
    const hint = next
      ? ` Consider calling advance_phase("${next}") if your ${phase} work is complete (after save_artifact when required).`
      : "";
    return [
      `You have spent ${turns} turns in the '${phase}' phase.`,
      `If the ${phase} phase is complete, advance to the next phase.${hint}`,
    ].join(" ");
  }
  return undefined;
}
