/**
 * Deterministic answer graders — ported from the rlm_test lab
 * (src/rlm_agent/bench/needle.py `NeedleTask.recall` + suite.py gold-containment).
 *
 * No LLM-as-judge: every suite grades the raw engine answer with a heuristic so runs are
 * reproducible and free-model variance stays measurable.
 */

export type Grade =
  | { readonly kind: "recall"; readonly needles: readonly string[] }
  | { readonly kind: "contains"; readonly gold: string }
  | { readonly kind: "regex"; readonly pattern: RegExp; readonly gold: string }
  /** Paper suites: partial-credit heuristic (ported from the lab). recall = score ∈ [0,1],
   *  correct only at full score. */
  | { readonly kind: "score"; readonly gold: string; readonly scoreOf: (answer: string) => number };

export interface GradeOutcome {
  readonly correct: boolean;
  readonly recall: number;
}

export function gradeAnswer(grade: Grade, answer: string): GradeOutcome {
  const text = answer ?? "";
  switch (grade.kind) {
    case "recall": {
      if (grade.needles.length === 0) return { correct: false, recall: 0 };
      const hits = grade.needles.filter((n) => text.includes(n)).length;
      const recall = hits / grade.needles.length;
      return { correct: recall >= 1, recall };
    }
    case "contains": {
      const ok = text.toLowerCase().includes(grade.gold.toLowerCase());
      return { correct: ok, recall: ok ? 1 : 0 };
    }
    case "regex": {
      const ok = grade.pattern.test(text);
      return { correct: ok, recall: ok ? 1 : 0 };
    }
    case "score": {
      const score = grade.scoreOf(text);
      return { correct: score >= 1, recall: score };
    }
  }
}
