/**
 * Root Σ (WS-3b/WS-4) — RootStateTracker: a digest-level Σ_t for the NATIVE Pi session.
 *
 * This is NOT the engine's RunStateTracker (core/engine turn loop); it is the root
 * orchestrator's sufficient statistic, living in the extension closure next to
 * controller/sandboxManager. It is runtime-derived — tool outcomes, engine-run mirrors,
 * the user's latest prompt — zero model cooperation required (paper §5.3: observation
 * override; §5.7: small models must not be the state's author by default). The optional
 * fence protocol (enableRootStateFences — ENFORCED ON since Root Σ v2 R0) is the only
 * model-proposed input and
 * rides the SAME V(ΔΣ_t,Σ_t) validator + retry/degrade ladder as engine runs.
 *
 * Caps/dedup/serialization are the engine's own machinery: RUN_STATE_LIMITS, dedupStrings,
 * enforceCaps, applyPatch — reused, never re-implemented here.
 */

import {
  applyPatch,
  dedupStrings,
  enforceCaps,
  freshRunState,
  malformedFenceProblem,
  patchErrorText,
  RUN_STATE_LIMITS,
  statePatchObservation,
  type ApproachOutcome,
  type MutableState,
  type PatchError,
  type RunState,
} from "./run-state.ts";
import type { Result } from "../util/errors.ts";
import type { StateFenceResult } from "../text/parsing.ts";

/** Consecutive failed outcomes on one key before the rectify hint fires (MAS2 Eq. 5 parity). */
const RECTIFY_FAILURE_THRESHOLD = 2;
/** Task restatement cap — mirrors run-state.ts TASK_MAX_CHARS (kept in sync by comment). */
const ROOT_TASK_MAX_CHARS = 200;

/** R4: idle-degrade threshold for the NATIVE root tracker — deliberately ROOT-SPECIFIC
 *  (soak finding, 2025-09-08 live sessions: qwen3.8-27b ×3, qwen3-30b/32b, gemini-flash).
 *  The engine's `RUN_STATE_IDLE_DEGRADE_TURNS = 4` is bench-tuned for runs conditioned on Σ
 *  from turn 1; NATIVE sessions have a cold-start ramp — first fences land on turn 3 (short
 *  tasks) or turn 5–6 (study tasks), so 4 amputated exactly before the first commit (2/2
 *  study sessions degraded at 4, then fenced at 5). 6 clears the observed ramp while still
 *  bounding the fence tax. The engine const and its tuning are untouched.
 */
export const ROOT_IDLE_DEGRADE_TURNS = 6;

/** R3 soak observability: per-turn fence outcome, returned by applyFences. */
export interface FenceOutcome {
  readonly fences: number;
  readonly accepted: number;
  readonly problems: number;
}

/** Root Σ mode — same discriminated union shape as the engine's (active | degraded). */
type RootStateMode =
  | { readonly kind: "active"; readonly retries: number }
  | { readonly kind: "degraded"; readonly reason: string };

export class RootStateTracker {
  private draft: MutableState;
  private mode: RootStateMode = { kind: "active", retries: 0 };
  private opCounter = 0;
  private dirtyFlag = false;
  /** R4: consecutive fence-eligible turns with zero accepted deltas (idle streak). */
  private idleFenceTurns = 0;
  private readonly failures = new Map<string, number>();
  private pendingObservation: string | undefined;
  private readonly retryMax: number;

  private constructor(task: string, retryMax: number) {
    const fresh = freshRunState(task);
    this.draft = {
      task: fresh.task,
      nextStep: fresh.nextStep,
      updatedAt: fresh.updatedAt,
      findings: [...fresh.findings],
      verifiedFacts: [...fresh.verifiedFacts],
      openQuestions: [...fresh.openQuestions],
      testedApproaches: { ...fresh.testedApproaches },
      artifacts: { ...fresh.artifacts },
    };
    this.retryMax = Math.max(0, Math.floor(retryMax));
  }

  static fresh(task: string, retryMax = 2): RootStateTracker {
    return new RootStateTracker(task.trim().slice(0, ROOT_TASK_MAX_CHARS), retryMax);
  }

  /** True when nothing worth splicing has accumulated — the context transform no-ops. */
  get isEmpty(): boolean {
    return (
      this.draft.findings.length === 0 &&
      this.draft.verifiedFacts.length === 0 &&
      Object.keys(this.draft.testedApproaches).length === 0 &&
      this.draft.nextStep === ""
    );
  }

  get dirty(): boolean {
    return this.dirtyFlag;
  }

  /** R4: true while the tracker accepts fences and the context transform may splice Σ. */
  get isActive(): boolean {
    return this.mode.kind === "active";
  }

  /** R4 telemetry: consecutive fence-eligible turns with zero accepted deltas. */
  get idleTurns(): number {
    return this.idleFenceTurns;
  }

  /** R4 telemetry: the degrade reason while degraded; undefined while active. */
  get degradeReason(): string | undefined {
    return this.mode.kind === "degraded" ? this.mode.reason : undefined;
  }

  snapshot(): RunState {
    const capped = enforceCaps(this.draft);
    // enforceCaps never fails in practice; the fallback keeps the tracker fail-soft anyway.
    return capped.ok ? capped.value : freshRunState(this.draft.task);
  }

  noteFinding(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.draft.findings = dedupStrings([...this.draft.findings, trimmed]).slice(-RUN_STATE_LIMITS.findings);
    this.touch();
  }

  noteFact(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.draft.verifiedFacts = dedupStrings([...this.draft.verifiedFacts, trimmed])
      .slice(-RUN_STATE_LIMITS.verifiedFacts);
    this.touch();
  }

  noteOutcome(key: string, outcome: ApproachOutcome): void {
    const k = key.trim();
    if (k === "") return;
    this.draft.testedApproaches[k] = outcome;
    if (outcome.status === "failed") {
      this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
    } else {
      this.failures.delete(k);
    }
    this.touch();
  }

  /** Tool-outcome feed (WS-4 v1 source): failures become approach outcomes, verbatim. */
  observeToolResult(toolName: string, isError: boolean, reasonFirstLine: string): void {
    if (isError) {
      this.noteOutcome(`tool:${toolName}`, { status: "failed", reason: reasonFirstLine });
    } else {
      // A success clears the tool's failure streak — the state reflects the newest truth.
      if (this.draft.testedApproaches[`tool:${toolName}`] !== undefined) {
        this.noteOutcome(`tool:${toolName}`, { status: "succeeded", evidence: reasonFirstLine });
      } else {
        this.failures.delete(`tool:${toolName}`);
      }
    }
  }

  /** The user's latest ask IS the next step by definition (WS-4 v1 source). Empty is a no-op. */
  setNextStep(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    this.draft.nextStep = trimmed.slice(0, 300);
    this.touch();
  }

  /**
   * WS-4 mirror: absorb a finished engine run's Σ (same object the SkillState harvest
   * consumes — one source, two sinks). Findings/facts dedup through the shared key; the
   * engine's approach outcomes ride along under their own keys.
   */
  absorbEngineState(engine: RunState): void {
    this.draft.findings = dedupStrings([...this.draft.findings, ...engine.findings])
      .slice(-RUN_STATE_LIMITS.findings);
    this.draft.verifiedFacts = dedupStrings([...this.draft.verifiedFacts, ...engine.verifiedFacts])
      .slice(-RUN_STATE_LIMITS.verifiedFacts);
    for (const [key, outcome] of Object.entries(engine.testedApproaches)) {
      this.draft.testedApproaches[key] = outcome;
    }
    if (this.draft.task === "") this.draft.task = engine.task;
    this.touch();
  }

  /**
   * WS-4.2 (default OFF): model-proposed ΔΣ_t fences through the ONE validator. EXACT ladder
   * parity with the engine's `applyStatePatches` (N3): every fence is processed — accepted
   * deltas land sequentially, ALL problems accumulate into ONE observation (error-as-
   * observation), and only past `runStateRetryMax` total rejections the tracker degrades and
   * fences stop being applied. Wording delegates to run-state.ts (N1) — one source.
   *
   * R4 (G6, /tmp/ROOT_FULL_SKILLSTATE_PLAN.md): idle-degrade parity with the engine — once
   * the native prompt teaches the fence contract, EVERY finalized assistant turn is
   * fence-eligible; a turn with zero accepted deltas grows `idleFenceTurns` and
   * `ROOT_IDLE_DEGRADE_TURNS` consecutive idle turns degrade the tracker (an idle Σ is
   * pure input tax — bench rec #2, paper §5.7; root threshold is 6, not the engine's 4 —
   * see the const's soak citation). Any accepted delta resets the streak. In
   * degraded mode fences stop applying and the context transform stops splicing (`isActive`),
   * while runtime `observeToolResult` remains the Σ floor (degrade, never crash).
   */
  applyFences(fences: readonly StateFenceResult[]): FenceOutcome {
    // R7-fix (recoverable degrade): a DEGRADED tracker no longer drops fences on the floor.
    // The old early-return turned idle degrade into a one-way amnesia valve — every later
    // fence vanished silently while the context transform kept eliding turns. Now the same
    // validation ladder runs in degraded mode, and a CLEAN batch re-activates compensation.
    // Degrade stays sticky only against zero-progress storms (all-malformed batches).
    if (fences.length === 0) {
      // R4 (G6): a fence-free turn on a conditioned loop is IDLE — the contract rode the
      // prompt for nothing. Grow the streak; degrade at the engine's threshold.
      this.idleFenceTurns += 1;
      this.degradeIfIdle();
      return { fences: 0, accepted: 0, problems: 0 };
    }
    let state = this.snapshot();
    const problems: string[] = [];
    let accepted = 0;
    for (const fence of fences) {
      if (!fence.ok) {
        problems.push(malformedFenceProblem(fence.error));
        continue;
      }
      const next: Result<RunState, PatchError> = applyPatch(state, fence.value, ++this.opCounter);
      if (next.ok) {
        state = next.value;
        accepted += 1;
      } else {
        problems.push(patchErrorText(next.error));
      }
    }
    // Accepted deltas reset the idle streak — even in a partially-failing batch (engine
    // parity: real work is never punished for a sibling's malformed fence).
    this.idleFenceTurns = accepted > 0 ? 0 : this.idleFenceTurns + 1;
    this.degradeIfIdle();
    if (problems.length === 0) {
      // Recovery seam: a clean batch re-activates a degraded tracker, so one honest fence
      // ends the amnesia window instead of requiring a session restart.
      this.mode = { kind: "active", retries: 0 };
      this.pendingObservation = undefined;
      this.draft = this.toMutable(state);
      this.touch();
      return { fences: fences.length, accepted, problems: 0 };
    }
    // Degraded variant carries `reason`, not `retries` — recovery is clean-batch-only, so a
    // degraded tracker neither accumulates retries nor re-activates on a partial batch.
    const retries = (this.mode.kind === "active" ? this.mode.retries : 0) + problems.length;
    this.pendingObservation = statePatchObservation(problems);
    // Accepted deltas in a partially-failing batch still land — engine parity: real work is
    // never rolled back just because a sibling fence was malformed.
    this.draft = this.toMutable(state);
    this.touch();
    if (this.mode.kind === "active") {
      if (retries > this.retryMax) {
        this.mode = { kind: "degraded", reason: `state-patch retry cap exceeded (${retries} rejected)` };
      } else {
        // Persist the running rejection count — the retry cap is CUMULATIVE across turns.
        this.mode = { kind: "active", retries };
      }
    }
    return { fences: fences.length, accepted, problems: problems.length };
  }

  /** R4: fire the idle degrade at the root threshold (active trackers only). */
  private degradeIfIdle(): void {
    if (this.mode.kind === "active" && this.idleFenceTurns >= ROOT_IDLE_DEGRADE_TURNS) {
      this.mode = {
        kind: "degraded",
        reason: `idle degrade — ${this.idleFenceTurns} consecutive turns with zero accepted deltas`,
      };
    }
  }

  /** Consume (and clear) the pending fence-rejection observation, if any. */
  takePendingObservation(): string | undefined {
    const observation = this.pendingObservation;
    this.pendingObservation = undefined;
    return observation;
  }

  /**
   * WS-4 rectify parity (budget.ts:rectify ideas, deterministic): after N consecutive
   * failed outcomes on one key, suggest the local fix — never a model switch.
   */
  rectifyHint(): string | undefined {
    if (this.mode.kind !== "active") return undefined;
    for (const [key, count] of this.failures) {
      if (count >= RECTIFY_FAILURE_THRESHOLD) {
        return `[rectify] '${key}' failed ${count}× consecutively — narrow the approach ` +
          "(different path/tool/slice) instead of retrying blind (MAS2 Eq. 5).";
      }
    }
    return undefined;
  }

  private toMutable(state: RunState): MutableState {
    return {
      task: state.task,
      nextStep: state.nextStep,
      updatedAt: state.updatedAt,
      findings: [...state.findings],
      verifiedFacts: [...state.verifiedFacts],
      openQuestions: [...state.openQuestions],
      testedApproaches: { ...state.testedApproaches },
      artifacts: { ...state.artifacts },
    };
  }

  private touch(): void {
    this.opCounter += 1;
    this.draft.updatedAt = this.opCounter;
    this.dirtyFlag = true;
  }
}
