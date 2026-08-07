/**
 * The phase pipeline's stateful half: the `save_artifact` / `advance_phase` sandbox handlers
 * and the validate-phase finalize routing.
 *
 * Pulled out of the engine's run closure so the pipeline's mutable state (current phase, the
 * per-phase latest save, serviced ask rounds, accumulated warnings, a pending history reset)
 * lives in one owner instead of six `let`s threaded through a 640-line function.
 *
 * Two invariants this file exists to protect:
 *  - Gates measure the CURRENT phase's latest save (`lastSaved`) only — never
 *    `phase.artifacts`, whose paths are the completed channel and go stale across a
 *    corrective loop-back.
 *  - `lastSaved` and `askRounds` are session-only. They are never rehydrated from the trail,
 *    so a resumed run must genuinely re-save and re-interview rather than re-gate stale work.
 */

import type { ChatMsg } from "../bridge/model.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import type { PhaseRecon } from "../state/resume.ts";
import { formatError } from "../util/errors.ts";
import { readArtifact, saveArtifact, type GoalCapture } from "./artifacts.ts";
import { critiqueArtifact, formatCritique } from "./critique.ts";
import {
  advancePhase as validatePhaseTransition,
  initialPhaseState,
  isPhase,
  PHASES,
  reconcilePhase,
  routeAfterValidate,
  stageForArtifactKind,
  STAGES,
  type ArtifactRef,
  type Phase,
  type PhaseState,
  type SavedArtifact,
  type StageGateData,
} from "./pipeline.ts";

/** Builds the fresh-session history for a phase. Supplied by the engine (its own policy). */
export type ResetHistoryForPhase = (
  state: PhaseState,
  options: { readonly goal?: GoalCapture; readonly validation?: import("./gates.ts").ValidationGateData; readonly notice?: string },
) => ChatMsg[];

/** Appends a `phase` row to the run trail. Supplied by the engine (owns persistence state). */
export type PersistPhaseRow = (
  state: PhaseState,
  artifactPath: string | undefined,
  artifactPhase: Phase | undefined,
  gateData: StageGateData | undefined,
  supersededPath?: string,
) => Promise<void>;

export interface PipelineDeps {
  /** Repo root that artifact paths are resolved against. */
  readonly runCwd: string;
  readonly maxBackwardJumps: number;
  readonly emitter: RlmEmitter;
  /** Turns completed so far — phase rows and `advancedAt` are stamped with it. */
  readonly completedTurns: () => number;
  readonly resetHistoryForPhase: ResetHistoryForPhase;
  readonly persistPhaseRow: PersistPhaseRow;
}

/** What the engine should do with a finalize submitted while in the `validate` phase. */
export type ValidateOutcome =
  /** Not finalizable yet — feed `error` back as the next turn's REPL output. */
  | { readonly kind: "reject"; readonly error: string }
  /** Blockers found — re-enter `blueprint` with this fresh history. */
  | { readonly kind: "loop-back"; readonly history: ChatMsg[] }
  /** Backward-jump cap reached — terminate with this report. */
  | { readonly kind: "halt"; readonly report: string }
  /** Validation passed — take the model's final answer. */
  | { readonly kind: "accept" };

/** The sandbox handlers the pipeline contributes. Shape-compatible with `SubLlmHandlers`. */
export interface PipelineHandlers {
  saveArtifact(kind: string, content: string): Promise<string>;
  advancePhase(phase: string, summary: string | undefined): Promise<string>;
}

export class PipelineController {
  /** Current phase state; `undefined` until seeded. Read by the engine for gate prompts/rows. */
  phase: PhaseState | undefined;

  /**
   * Latest save per phase: path plus an optional gate memo, as ONE record so the two cannot
   * desync. Cleared on phase exit and on loop-back.
   */
  private lastSaved: Partial<Record<Phase, SavedArtifact>> = {};

  /** Serviced ask_user_question rounds in the current phase (session-only). */
  private askRounds = 0;

  /** Advisory critique warnings accumulated across saves (surfaced in the TUI). */
  private warnings: readonly string[] = [];

  /** History replacement scheduled by advance_phase; the engine drains it at a turn boundary. */
  private pendingReset: ChatMsg[] | undefined;

  private goal: GoalCapture | undefined;

  constructor(private readonly deps: PipelineDeps) {}

  /** Called after each successfully serviced root-depth ask_user_question round. */
  noteAskRound(): void {
    this.askRounds++;
  }

  /** Take and clear the scheduled fresh-session history, if advance_phase left one. */
  takePendingReset(): ChatMsg[] | undefined {
    const reset = this.pendingReset;
    this.pendingReset = undefined;
    return reset;
  }

  /** Seed a fresh run: capture goal, enter `startPhase`, and build the opening history. */
  seedFresh(startPhase: Phase, goal: GoalCapture | undefined, notice: string | undefined): ChatMsg[] {
    this.goal = goal;
    this.phase = initialPhaseState(0, startPhase);
    return this.deps.resetHistoryForPhase(this.phase, { goal, notice });
  }

  /**
   * Rehydrate phase state from a trail. `lastSaved`/`askRounds` stay empty by design: a
   * resume must re-save and re-interview rather than re-gate work from a previous process.
   */
  seedFromResume(recon: PhaseRecon): void {
    const artifacts: Partial<Record<Phase, ArtifactRef>> = {};
    for (const [key, value] of Object.entries(recon.artifacts ?? {})) {
      if (value === undefined || !isPhase(key)) continue;
      artifacts[key] = Object.freeze({
        path: value.path,
        status: value.superseded ? ("superseded" as const) : ("active" as const),
      });
    }
    this.phase = {
      current: reconcilePhase(recon.current),
      advancedAt: recon.advancedAt,
      summary: recon.summary,
      artifacts,
      backwardJumps: recon.backwardJumps ?? 0,
    };
    this.lastSaved = {};
    this.askRounds = 0;
  }

  handlers(): PipelineHandlers {
    return {
      saveArtifact: (kind, content) => this.handleSaveArtifact(kind, content),
      advancePhase: (phase, summary) => this.handleAdvancePhase(phase, summary),
    };
  }

  // ── save_artifact ──

  private async handleSaveArtifact(kind: string, content: string): Promise<string> {
    const stage = stageForArtifactKind(kind);
    if (stage === undefined) {
      return formatError(`unknown artifact kind '${kind}' (valid: clarification, research, plan, validation)`);
    }
    const current = this.currentPhase();
    if (stage.phase !== current) {
      return formatError(`artifact kind '${kind}' belongs to phase '${stage.phase}', but the pipeline is in '${current}'`);
    }
    const saved = saveArtifact(this.deps.runCwd, stage.artifactDir, kind, content);
    if (!saved.ok) return formatError(saved.error);

    // Preflight: run the SAME gate advance_phase will run, now instead of a turn later, and
    // memoize the verdict so the transition does not re-read and re-gate the file.
    const critique = critiqueArtifact(stage, content, saved.path, this.deps.runCwd);
    this.lastSaved = {
      ...this.lastSaved,
      [stage.phase]: Object.freeze({ path: saved.path, gateData: critique.gateData }),
    };
    if (critique.warnings.length > 0) {
      this.warnings = Object.freeze([...this.warnings, ...critique.warnings]);
      this.deps.emitter.emitWarnings(this.warnings);
    }
    return `ok — saved ${saved.path}.\n${formatCritique(critique)}`;
  }

  // ── advance_phase ──

  private async handleAdvancePhase(phase: string, summary: string | undefined): Promise<string> {
    const current = this.currentPhase();
    const outcome = validatePhaseTransition(current, phase);
    if (!outcome.ok) return formatError(outcome.error);

    // Clarify interview gate: the engine counts serviced rounds itself, so the model cannot
    // advance by merely claiming to have interviewed the user.
    if (current === "clarify" && this.askRounds === 0) {
      return formatError("clarify requires at least one ask_user_question round — interview the user before advancing");
    }

    const gated = this.gateCurrentPhase(current);
    if (!gated.ok) return formatError(gated.error);
    const { artifactPath, gateData } = gated;

    const nextArtifacts: Partial<Record<Phase, ArtifactRef>> = { ...(this.phase?.artifacts ?? {}) };
    if (artifactPath !== undefined) {
      nextArtifacts[current] = Object.freeze({ path: artifactPath, status: "active" });
    }
    this.phase = {
      current: outcome.phase,
      advancedAt: this.deps.completedTurns(),
      summary,
      artifacts: nextArtifacts,
      backwardJumps: this.phase?.backwardJumps ?? 0,
    };
    await this.deps.persistPhaseRow(this.phase, artifactPath, artifactPath !== undefined ? current : undefined, gateData);
    this.clearLastSaved(current);
    this.askRounds = 0;
    this.pendingReset = this.deps.resetHistoryForPhase(this.phase, { goal: this.goal });
    return `ok — phase advanced to '${outcome.phase}' (was '${current}'${summary ? `, summary: ${summary.slice(0, 80)}` : ""})`;
  }

  /**
   * Measure the current phase's latest save. Deliberately reads `lastSaved` only — falling
   * back to `phase.artifacts` would let a stale path from before a loop-back pass the gate.
   */
  private gateCurrentPhase(
    current: Phase,
  ): { ok: true; artifactPath: string | undefined; gateData: StageGateData | undefined } | { ok: false; error: string } {
    const stage = STAGES[current];
    if (stage.artifactDir === "") return { ok: true, artifactPath: undefined, gateData: undefined };

    const savedEntry = this.lastSaved[current];
    const artifactPath = savedEntry?.path;
    if (artifactPath === undefined) {
      return {
        ok: false,
        error: `phase '${current}' has no saved artifact — call save_artifact("${stage.artifactKind}", content) first`,
      };
    }
    if (savedEntry?.gateData !== undefined) {
      return { ok: true, artifactPath, gateData: savedEntry.gateData };
    }
    // No memo (e.g. the file was written outside save_artifact) — read and gate it now.
    const content = readArtifact(this.deps.runCwd, artifactPath);
    if (!content.ok) return { ok: false, error: content.error };
    const gate = stage.gate(content.value, artifactPath, this.deps.runCwd);
    if (!gate.ok) return { ok: false, error: gate.error };
    this.lastSaved = {
      ...this.lastSaved,
      [current]: Object.freeze({ path: artifactPath, gateData: gate.value }),
    };
    return { ok: true, artifactPath, gateData: gate.value };
  }

  // ── validate-phase finalize ──

  /**
   * Decide what a finalize submitted during `validate` means. As with advance_phase, this
   * measures THIS turn's validation save only, never `phase.artifacts`.
   */
  async finalizeInValidate(final: string): Promise<ValidateOutcome> {
    const phase = this.phase;
    if (phase === undefined) return { kind: "accept" };

    const vPath = this.lastSaved.validate?.path;
    if (vPath === undefined) {
      return {
        kind: "reject",
        error: formatError(
          'finalize rejected — save the validation artifact first via save_artifact("validation", content) with status: ready, blockers_count, and verdict',
        ),
      };
    }
    const content = readArtifact(this.deps.runCwd, vPath);
    if (!content.ok) return { kind: "reject", error: formatError(content.error) };

    const gate = STAGES.validate.gate(content.value, vPath, this.deps.runCwd);
    if (!gate.ok) return { kind: "reject", error: formatError(gate.error) };
    if (gate.value.kind !== "validation") {
      return { kind: "reject", error: formatError("internal: validate gate did not return validation data") };
    }

    const { validation } = gate.value;
    const route = routeAfterValidate(validation, phase.backwardJumps, this.deps.maxBackwardJumps);
    if (route.kind === "halt") return { kind: "halt", report: `${route.reason}\n\n${final}` };
    if (route.kind !== "loop-back") return { kind: "accept" };

    // Loop back to blueprint. Prior artifacts are kept — the append-only journal marks the
    // blueprint superseded by this validation rather than dropping it.
    const prior = phase.artifacts.blueprint;
    const nextArtifacts: Partial<Record<Phase, ArtifactRef>> = {
      ...phase.artifacts,
      validate: Object.freeze({ path: vPath, status: "active" }),
    };
    if (prior !== undefined) {
      nextArtifacts.blueprint = Object.freeze({ path: prior.path, status: "superseded", supersededBy: vPath });
    }
    this.phase = {
      current: "blueprint",
      advancedAt: this.deps.completedTurns(),
      summary: `loop-back: ${validation.blockersCount} blocker(s)`,
      artifacts: nextArtifacts,
      backwardJumps: phase.backwardJumps + 1,
    };
    await this.deps.persistPhaseRow(this.phase, vPath, "validate", gate.value, prior?.path);
    // Clear BOTH so the re-entered blueprint must produce a genuinely fresh plan and a fresh
    // validation of it, rather than re-gating what was just rejected.
    this.clearLastSaved("blueprint", "validate");
    this.askRounds = 0;
    this.pendingReset = undefined;
    return { kind: "loop-back", history: this.deps.resetHistoryForPhase(this.phase, { goal: this.goal, validation }) };
  }

  private currentPhase(): Phase {
    return this.phase?.current ?? PHASES[0];
  }

  private clearLastSaved(...phases: readonly Phase[]): void {
    const next: Partial<Record<Phase, SavedArtifact>> = { ...this.lastSaved };
    for (const phase of phases) delete next[phase];
    this.lastSaved = next;
  }
}
