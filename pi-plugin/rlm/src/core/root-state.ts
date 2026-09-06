/**
 * Root Σ (WS-3b/WS-4) — RootStateTracker: a digest-level Σ_t for the NATIVE Pi session.
 *
 * This is NOT the engine's RunStateTracker (core/engine turn loop); it is the root
 * orchestrator's sufficient statistic, living in the extension closure next to
 * controller/sandboxManager. It is runtime-derived — tool outcomes, engine-run mirrors,
 * the user's latest prompt — zero model cooperation required (paper §5.3: observation
 * override; §5.7: small models must not be the state's author by default). The optional
 * fence protocol (enableRootStateFences, default OFF) is the only model-proposed input and
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

/** Root Σ mode — same discriminated union shape as the engine's (active | degraded). */
type RootStateMode =
  | { readonly kind: "active"; readonly retries: number }
  | { readonly kind: "degraded"; readonly reason: string };

export class RootStateTracker {
  private draft: MutableState;
  private mode: RootStateMode = { kind: "active", retries: 0 };
  private opCounter = 0;
  private dirtyFlag = false;
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
   */
  applyFences(fences: readonly StateFenceResult[]): void {
    if (this.mode.kind !== "active" || fences.length === 0) return;
    let state = this.snapshot();
    const problems: string[] = [];
    for (const fence of fences) {
      if (!fence.ok) {
        problems.push(malformedFenceProblem(fence.error));
        continue;
      }
      const next: Result<RunState, PatchError> = applyPatch(state, fence.value, ++this.opCounter);
      if (next.ok) {
        state = next.value;
      } else {
        problems.push(patchErrorText(next.error));
      }
    }
    if (problems.length === 0) {
      this.mode = { kind: "active", retries: 0 };
      this.pendingObservation = undefined;
      this.draft = this.toMutable(state);
      this.touch();
      return;
    }
    const retries = this.mode.retries + problems.length;
    this.pendingObservation = statePatchObservation(problems);
    // Accepted deltas in a partially-failing batch still land — engine parity: real work is
    // never rolled back just because a sibling fence was malformed.
    this.draft = this.toMutable(state);
    this.touch();
    if (retries > this.retryMax) {
      this.mode = { kind: "degraded", reason: `state-patch retry cap exceeded (${retries} rejected)` };
    } else {
      this.mode = { kind: "active", retries };
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
