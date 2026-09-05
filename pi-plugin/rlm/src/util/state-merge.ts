/**
 * THE deep-merge with null-deletion (SKILL.state paper §3.2, the `⊕` operator) — one
 * implementation shared by the RunState patch path (core/run-state.ts, Workstream A) and the
 * SkillState note merge (config/skillstate.ts, Workstream B). Never inline a second merge.
 *
 *   x ⊕ {k: null} = x without k            (delete — must be explicit, never silent)
 *   x ⊕ {k: v}    = x[k] ⊕ v if both are plain objects (deep merge)
 *                   else v                  (replace)
 *
 * Arrays are replaced wholesale: array semantics (append, index-set, dedup, eviction) are
 * domain policy and live with the callers that understand them (see core/run-state.ts).
 * A non-object patch replaces the base as-is.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeWithNullDeletion(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]; // explicit null = delete (paper §3.2)
      continue;
    }
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMergeWithNullDeletion(current, value)
      : value;
  }
  return out;
}
