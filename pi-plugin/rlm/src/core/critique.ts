/**
 * Preflight critique for stage artifacts — port of codex-bais `model_critique`.
 *
 * Blocking truth comes from `stage.gate` (the same function `advance_phase` runs), so the
 * two can never drift. `warnings` are advisory model-risk diagnostics that never block.
 */
import {
  countBulletsUnderHeading,
  phasesMissingSuccessCriteria,
  sectionHasNonEmptyBody,
} from "./gates.ts";
import type { StageDef, StageGateData } from "./pipeline.ts";

export interface Critique {
  /** Blocking — `advance_phase` will reject while non-empty. */
  readonly issues: readonly string[];
  /** Advisory — surfaced to the model, never blocking. */
  readonly warnings: readonly string[];
  /**
   * Convenience alias for `issues.length === 0` — do not set independently;
   * always derive from `issues`.
   */
  readonly canAdvance: boolean;
  /** Gate payload when `canAdvance` — reused by advance_phase (no second gate run). */
  readonly gateData?: StageGateData;
}

const NO_STRINGS: readonly string[] = Object.freeze([]);

/** Advisory checks per artifact kind. Pure; returns a frozen array. */
function advisoriesFor(stage: StageDef, content: string): readonly string[] {
  switch (stage.artifactKind) {
    case "plan": {
      const missing = phasesMissingSuccessCriteria(content);
      if (missing.length > 0) {
        return Object.freeze([
          `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no `
          + "'### Success Criteria' — validate cannot check them",
        ]);
      }
      return NO_STRINGS;
    }
    case "clarification": {
      const open = countBulletsUnderHeading(content, "Open Questions");
      if (open > 0) {
        return Object.freeze([
          `${open} Open Question(s) carried into blueprint — re-ask any that block the design`,
        ]);
      }
      return NO_STRINGS;
    }
    case "research": {
      if (!sectionHasNonEmptyBody(content, "Findings")) {
        return Object.freeze(["research artifact has no '## Findings' section"]);
      }
      return NO_STRINGS;
    }
    default:
      return NO_STRINGS;
  }
}

export function critiqueArtifact(
  stage: StageDef,
  content: string,
  path: string,
  cwd: string,
): Critique {
  const gate = stage.gate(content, path, cwd);
  const issues = gate.ok ? NO_STRINGS : Object.freeze([gate.error]);
  return Object.freeze({
    issues,
    warnings: advisoriesFor(stage, content),
    canAdvance: issues.length === 0,
    gateData: gate.ok ? gate.value : undefined,
  });
}

/** Human-readable renderer for the `save_artifact` return value. */
export function formatCritique(critique: Critique): string {
  if (critique.issues.length === 0 && critique.warnings.length === 0) {
    return "gate: clean — call advance_phase when ready.";
  }
  const lines = new Array<string>(critique.issues.length + critique.warnings.length);
  let n = 0;
  for (let i = 0; i < critique.issues.length; i++) lines[n++] = `  BLOCKER: ${critique.issues[i]}`;
  for (let i = 0; i < critique.warnings.length; i++) lines[n++] = `  warning: ${critique.warnings[i]}`;
  const head = critique.canAdvance
    ? "gate: passes, with advisories —"
    : "gate: WOULD REJECT — fix before advance_phase:";
  return `${head}\n${lines.join("\n")}`;
}
