/**
 * Artifact plumbing for the gated RLM pipeline: goal capture, baseline dirty-tree
 * snapshot, and timestamped stage artifact writes under `.rlm/artifacts/`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../util/errors.ts";

export const ARTIFACTS_DIR = ".rlm/artifacts";

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export interface GoalCapture {
  readonly goalPath: string;      // repo-relative
  readonly baselinePath: string;  // repo-relative
}

export type SaveOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

export type GoalCaptureResult =
  | { readonly ok: true; readonly value: GoalCapture }
  | { readonly ok: false; readonly error: string };

/**
 * Capture the user's brief VERBATIM: no frontmatter, no headers — the raw file
 * is the only artifact that preserves explicit user constraints unrefracted. The
 * baseline snapshot records paths ALREADY dirty before the run, so validate
 * judges only the run's own delta. Best-effort: git failure ⇒ empty baseline.
 * Failures never throw (unwritable cwd etc.) — returns error for the engine to surface.
 */
export function captureGoal(cwd: string, brief: string): GoalCaptureResult {
  try {
    const ts = stamp();
    const dir = join(ARTIFACTS_DIR, "goal");
    mkdirSync(join(cwd, dir), { recursive: true });
    const goalPath = join(dir, `goal-${ts}.md`);
    writeFileSync(join(cwd, goalPath), brief, "utf-8");
    let paths: readonly string[] = [];
    try {
      paths = execFileSync("git", ["status", "--short"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => {
          const rest = l.slice(3).trim();
          const arrow = rest.indexOf(" -> ");
          return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
        });
    } catch {
      paths = [];
    }
    const baselinePath = join(dir, `baseline-${ts}.json`);
    writeFileSync(join(cwd, baselinePath), JSON.stringify({ paths }, null, 2), "utf-8");
    return { ok: true, value: { goalPath, baselinePath } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Write a stage artifact under its dir; timestamped so runs never collide. */
export function saveArtifact(cwd: string, dir: string, slug: string, content: string): SaveOutcome {
  try {
    const rel = join(ARTIFACTS_DIR, dir, `${stamp()}_${slug}.md`);
    mkdirSync(join(cwd, ARTIFACTS_DIR, dir), { recursive: true });
    writeFileSync(join(cwd, rel), content, "utf-8");
    return { ok: true, path: rel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Read a previously saved artifact (repo-relative path). Failures never throw. */
export function readArtifact(cwd: string, relPath: string): Result<string, string> {
  try {
    return { ok: true, value: readFileSync(join(cwd, relPath), "utf-8") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not read artifact ${relPath}: ${message}` };
  }
}
