/**
 * Deterministic answer grader — the oolong partial-credit heuristic (ported from the rlm_test
 * lab's suite.py). No LLM-as-judge: the raw engine answer is scored by a heuristic so runs are
 * reproducible and provider variance stays measurable.
 */

export type Grade =
  /** Paper suites: partial-credit heuristic. recall = score ∈ [0,1], correct only at full score. */
  | { readonly kind: "score"; readonly gold: string; readonly scoreOf: (answer: string) => number };

export interface GradeOutcome {
  readonly correct: boolean;
  readonly recall: number;
}

export function gradeAnswer(grade: Grade, answer: string): GradeOutcome {
  const text = answer ?? "";
  const score = grade.scoreOf(text);
  return { correct: score >= 1, recall: score };
}
