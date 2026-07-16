import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import { errorMessage, formatError } from "../util/errors.ts";

export interface AnchorEdit {
  readonly oldText: string;
  readonly newText: string;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) return count;
    count++;
    offset = match + needle.length;
  }
}

/**
 * Literal string replace of the first occurrence of `oldText` with `newText`.
 * Splice-based so `$&` / `$$` / `$'` in newText are NOT treated as
 * special replacement patterns (String.prototype.replace string-form hazard).
 */
export function replaceOnceLiteral(content: string, oldText: string, newText: string): string {
  const idx = content.indexOf(oldText);
  if (idx < 0) return content;
  return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
}

export type PlanEditResult =
  | {
      readonly ok: true;
      /** create = new file; replace = one-shot anchor swap; already-applied = idempotent skip */
      readonly kind: "create" | "replace" | "already-applied";
      readonly before: string;
      readonly after: string;
    }
  | { readonly ok: false; readonly error: string };

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and compute an edit without writing.
 * Shared by headless apply and the native apply_edits tool (DRY).
 *
 * Idempotent retry: if a prior unit already landed the change
 * (oldText absent + newText already present for replace; create with identical content),
 * returns kind "already-applied" so a failed fanout can be retried without wedging.
 *
 * Create-file: refuses to clobber when the target exists with different content.
 */
export async function planEdit(
  cwd: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<PlanEditResult> {
  try {
    const fullPath = resolve(cwd, path);
    if (oldText.length === 0) {
      if (await pathExists(fullPath)) {
        const existing = await readFile(fullPath, "utf8");
        if (existing === newText) {
          return { ok: true, kind: "already-applied", before: existing, after: existing };
        }
        return {
          ok: false,
          error: formatError(
            `${path}: file already exists with different content — refuse to clobber (create requires empty target or identical content)`,
          ),
        };
      }
      return { ok: true, kind: "create", before: "", after: newText };
    }

    const content = await readFile(fullPath, "utf8");
    const occurrences = countOccurrences(content, oldText);
    if (occurrences === 0) {
      // Idempotent skip: prior apply already removed the anchor and left newText.
      // Deletions (newText === "") always "include" empty string — treat them as
      // retry-unsafe so a typo'd anchor fails instead of silently skipping.
      if (newText.length > 0 && content.includes(newText)) {
        return { ok: true, kind: "already-applied", before: content, after: content };
      }
      return { ok: false, error: formatError(`anchor occurs 0 times in ${path}`) };
    }
    if (occurrences !== 1) {
      return { ok: false, error: formatError(`anchor occurs ${occurrences} times in ${path}`) };
    }
    const after = replaceOnceLiteral(content, oldText, newText);
    return { ok: true, kind: "replace", before: content, after };
  } catch (err: unknown) {
    return { ok: false, error: formatError(`${path}: ${errorMessage(err)}`) };
  }
}

export type ApplyOneEditResult =
  | { readonly ok: true; readonly before: string; readonly after: string; readonly kind: "create" | "replace" | "already-applied" }
  | { readonly ok: false; readonly error: string };

/**
 * Apply a single anchor edit to the working tree (direct disk write).
 * Used by the implement fanout and any headless apply path.
 */
export async function applyOneEdit(
  cwd: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<ApplyOneEditResult> {
  const planned = await planEdit(cwd, path, oldText, newText);
  if (!planned.ok) return planned;
  if (planned.kind === "already-applied") {
    return { ok: true, before: planned.before, after: planned.after, kind: "already-applied" };
  }
  try {
    const fullPath = resolve(cwd, path);
    if (planned.kind === "create") {
      await mkdir(dirname(fullPath), { recursive: true });
    }
    await writeFile(fullPath, planned.after, "utf8");
    return { ok: true, before: planned.before, after: planned.after, kind: planned.kind };
  } catch (err: unknown) {
    return { ok: false, error: formatError(`${path}: ${errorMessage(err)}`) };
  }
}

export type ApplyProposedEditsResult =
  | { readonly ok: true; readonly applied: number }
  | { readonly ok: false; readonly error: string; readonly applied: number };

/**
 * Apply a series of proposed edits to the working tree (patch series, not a race).
 * Shared by the implement fanout and any headless apply path.
 * Safe to re-run: already-applied units succeed without re-writing.
 */
export async function applyProposedEdits(
  edits: readonly ProposedEdit[],
  cwd: string,
): Promise<ApplyProposedEditsResult> {
  let applied = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit === undefined) continue;
    const one = await applyOneEdit(cwd, edit.path, edit.oldText, edit.newText);
    if (!one.ok) {
      return { ok: false, error: one.error, applied };
    }
    applied++;
  }
  return { ok: true, applied };
}
