/** Internal helpers shared across the RLM run-state module. */

import { access, readdir } from "node:fs/promises";
import { errorMessage } from "../util/errors.ts";

export { errorMessage } from "../util/errors.ts";

export interface FailSoftOptions {
  readonly label?: string;
  readonly warn?: boolean;
}

const DEFAULT_FAIL_SOFT_OPTIONS = Object.freeze({});

export const warn = (e: unknown): void => console.warn(`[rlm-state] ${errorMessage(e)}`);

export async function failSoft<T>(
  fn: () => Promise<T>,
  fallback: T,
  options: FailSoftOptions = DEFAULT_FAIL_SOFT_OPTIONS,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (options.warn !== false) warn(options.label ? `${options.label}: ${errorMessage(e)}` : e);
    return fallback;
  }
}

export async function listDirectoriesSorted(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
