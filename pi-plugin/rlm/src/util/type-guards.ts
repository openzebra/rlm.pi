/** Shared runtime type guards — one implementation, imported everywhere (DRY). */

/** True for any non-null object value; the standard probe before field checks. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
