/**
 * Applies RLM-proposed edits to disk.
 *
 * Two edit kinds from the sandbox protocol:
 *   ProposedEdit      — oldText / newText anchor replacement
 *   ProposedDiffEdit  — unified diff string (applied via `diff.applyPatch`)
 *
 * Returns a Result. Caller decides whether to show errors in UI.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as Diff from "diff";
import type { ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";
import { err, ok, type Result } from "../util/errors.ts";

// ── Shared private helpers ─────────────────────────────────────────────────

/** Normalise to LF so string-replace is CRLF-safe. */
function toLF(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Restore original line endings after replacement. */
function restoreEndings(s: string, crlf: boolean): string {
  return crlf ? s.replace(/\n/g, "\r\n") : s;
}

function hasCRLF(s: string): boolean {
  return s.includes("\r\n");
}

// ── ApplyResult ─────────────────────────────────────────────────────────────

export interface ApplySuccess {
  readonly applied: number;
}

export interface ApplyFailure {
  readonly failures: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export type ApplyResult = Result<ApplySuccess, ApplyFailure>;

// ── Generic accumulator (shared by anchor + diff apply) ─────────────────────

/**
 * Runs `applyOne` for every item, tallying successes and collecting failures.
 * The only thing that differs between anchor and diff apply is the per-item
 * helper and the failure-path key — both passed in, so the loop is written once.
 */
async function applyAll<T>(
  items: readonly T[],
  applyOne: (item: T, cwd: string) => Promise<Result<void, string>>,
  getKey: (item: T) => string,
  cwd: string,
): Promise<ApplyResult> {
  const failures: Array<{ readonly path: string; readonly reason: string }> = [];
  let applied = 0;
  for (const item of items) {
    const r = await applyOne(item, cwd);
    if (r.ok) {
      applied++;
    } else {
      failures.push({ path: getKey(item), reason: r.error });
    }
  }
  return failures.length === 0 ? ok({ applied }) : err({ failures });
}

// ── ProposedEdit (oldText / newText) ────────────────────────────────────────

async function applySingleAnchor(
  edit: ProposedEdit,
  cwd: string,
): Promise<Result<void, string>> {
  const abs = resolve(cwd, edit.path);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    return err(`read error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const crlf = hasCRLF(raw);
  const content = toLF(raw);
  const needle = toLF(edit.oldText);
  if (!content.includes(needle)) {
    return err(`oldText not found in ${edit.path}`);
  }
  const replaced = content.replace(needle, toLF(edit.newText));
  try {
    await writeFile(abs, restoreEndings(replaced, crlf), "utf8");
    return ok(undefined);
  } catch (e) {
    return err(`write error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function applyAnchorEdits(
  edits: readonly ProposedEdit[],
  cwd: string,
): Promise<ApplyResult> {
  return applyAll(edits, applySingleAnchor, (e) => e.path, cwd);
}

// ── ProposedDiffEdit (unified diff string) ──────────────────────────────────

async function applySingleDiff(
  diffEdit: ProposedDiffEdit,
  cwd: string,
): Promise<Result<void, string>> {
  // Extract file path from diff header: "--- a/path" or "--- path"
  const match = /^--- (?:a\/)?(.+)$/m.exec(diffEdit.diff);
  const relPath = match?.[1]?.trim();
  if (relPath === undefined) {
    return err("diff has no '---' header; cannot determine target file");
  }
  const abs = resolve(cwd, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    return err(`read error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const crlf = hasCRLF(raw);
  let patched: string | false;
  try {
    patched = Diff.applyPatch(toLF(raw), diffEdit.diff);
  } catch (e) {
    return err(`invalid diff — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (patched === false) {
    return err(`patch does not apply cleanly to ${relPath}`);
  }
  try {
    await writeFile(abs, restoreEndings(patched, crlf), "utf8");
    return ok(undefined);
  } catch (e) {
    return err(`write error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function applyDiffEdits(
  diffs: readonly ProposedDiffEdit[],
  cwd: string,
): Promise<ApplyResult> {
  return applyAll(diffs, applySingleDiff, (d) => d.diff.slice(0, 40), cwd);
}
