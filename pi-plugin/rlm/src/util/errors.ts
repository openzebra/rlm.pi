/** Shared result and error-string helpers. */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T = never, E = string>(error: E): Result<T, E> {
  return { ok: false, error };
}

export const ERROR_PREFIX = "Error:";

export function formatError(message: string): string {
  return `${ERROR_PREFIX} ${message}`;
}

export function isErrorText(text: string): boolean {
  return text.startsWith(`${ERROR_PREFIX} `);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
