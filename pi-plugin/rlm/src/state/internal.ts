/** Internal helpers shared across the RLM run-state module. */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const warn = (e: unknown): void => console.warn(`[rlm-state] ${errorMessage(e)}`);
