/**
 * Deterministic gate floors for the RLM pipeline: the engine measures artifacts
 * instead of trusting the model's claim that a phase is complete.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Result } from "../util/errors.ts";

/** Gate outcome — same shape as Result; alias keeps call sites domain-clear. */
export type GateResult<T> = Result<T, string>;

export const MAX_PHASES = 32;

/** One parsed entry of a plan's `phases:` frontmatter array. */
export interface PhaseRecord {
  readonly n: number;
  readonly title: string;
  readonly index: number;
  readonly total: number;
}

export interface PlanGateData {
  readonly phases: readonly PhaseRecord[];
}

export interface ValidationGateData {
  readonly blockersCount: number;
  readonly verdict: "pass" | "fail";
}

const PLAN_PHASE_RE = /^## Phase (\d+):/;
const STATUS_READY = "ready";

/**
 * Count lines matching `re` OUTSIDE fenced code blocks — a `## Phase N:` inside
 * a ``` fence is example text, not a structural heading.
 */
export function countHeadingsOutsideFences(content: string, re: RegExp): number {
  const lineRe = new RegExp(re.source);
  let count = 0;
  let inFence = false;
  let fenceLen = 0;
  for (const line of content.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const len = (fence[1] ?? "").length;
      if (!inFence) {
        inFence = true;
        fenceLen = len;
      } else if (len >= fenceLen && line.trim().length === len) {
        inFence = false;
        fenceLen = 0;
      }
      continue;
    }
    if (!inFence && lineRe.test(line)) count++;
  }
  return count;
}

/** Frontmatter as a plain record (parseFrontmatter returns unknown-shaped data). */
function frontmatterOf(content: string): Record<string, unknown> {
  const { frontmatter } = parseFrontmatter(content);
  return typeof frontmatter === "object" && frontmatter !== null
    ? (frontmatter as Record<string, unknown>)
    : {};
}

/** `status: ready` floor — shared by every produces-stage gate. */
export function checkStatusReady(content: string, path: string): GateResult<undefined> {
  const status = frontmatterOf(content).status;
  return status === STATUS_READY
    ? { ok: true, value: undefined }
    : { ok: false, error: `artifact ${path} has status '${String(status)}' — set frontmatter status: ready before advancing` };
}

/**
 * Plan-structure floor:
 * `phases:` array ≡ fence-aware `## Phase N:` heading count, `phase_count` ≡
 * array length, count within [1, MAX_PHASES]. Stale array ⇒ reject, so the
 * fanout never dispatches a wrong unit list.
 */
export function planPhaseRecords(content: string, path: string): GateResult<PlanGateData> {
  const fm = frontmatterOf(content);
  const raw = fm.phases;
  const phases = Array.isArray(raw) ? raw : [];
  const headingCount = countHeadingsOutsideFences(content, PLAN_PHASE_RE);
  if (phases.length !== headingCount) {
    return { ok: false, error: `plan ${path}: frontmatter phases (${phases.length}) ≠ '## Phase N:' headings (${headingCount}) — rebuild the phases: array from the body headings` };
  }
  if (fm.phase_count !== phases.length) {
    return { ok: false, error: `plan ${path}: phase_count (${String(fm.phase_count)}) ≠ phases length (${phases.length}) — rebuild phase_count` };
  }
  if (phases.length === 0) {
    return { ok: false, error: `plan ${path}: declares no '## Phase N:' sections — a plan needs at least one phase` };
  }
  if (phases.length > MAX_PHASES) {
    return { ok: false, error: `plan ${path}: ${phases.length} phases exceeds MAX_PHASES (${MAX_PHASES}) — split the plan` };
  }
  const records = new Array<PhaseRecord>(phases.length);
  for (let index = 0; index < phases.length; index++) {
    const entry = phases[index];
    const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    records[index] = {
      n: typeof e.n === "number" ? e.n : index + 1,
      title: typeof e.title === "string" ? e.title : "",
      index,
      total: phases.length,
    };
  }
  return { ok: true, value: { phases: records } };
}

/**
 * Citation floor (direct path resolution only): every `path/file.ext:NN[-MM]`
 * in the artifact body must name a real file with at least NN lines. Unbacked
 * citations are fabricated precision — reject before they mislead implement.
 */
const FILE_LINE_CITATION_RE =
  /((?:(?<![\w.])\.)?(?<!\w)[\w][\w./-]*\.[a-zA-Z][a-zA-Z0-9]{0,4}):(\d+)(?:-(\d+))?/g;

export function verifyCitations(body: string, cwd: string): GateResult<undefined> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(FILE_LINE_CITATION_RE)) {
    const path = m[1];
    const startStr = m[2];
    const endStr = m[3];
    if (path === undefined || startStr === undefined) continue;
    const key = `${path}:${startStr}${endStr !== undefined ? `-${endStr}` : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const abs = isAbsolute(path) ? path : join(cwd, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`unbacked citation ${key} — file does not exist (use a repo-root-relative path or drop the line numbers)`);
      continue;
    }
    let lineCount: number;
    try {
      lineCount = readFileSync(abs, "utf-8").split("\n").length;
    } catch {
      errors.push(`unbacked citation ${key} — file could not be read`);
      continue;
    }
    const high = Math.max(Number(startStr), endStr !== undefined ? Number(endStr) : 0);
    if (high > lineCount) {
      errors.push(`unbacked citation ${key} — file has ${lineCount} lines; correct the range or drop the line numbers`);
    }
  }
  return errors.length === 0
    ? { ok: true, value: undefined }
    : { ok: false, error: errors.slice(0, 10).join("\n") };
}

/**
 * Validation-contract floor: the validate artifact must carry the numeric gate
 * field (`blockers_count`) so routing is measured, never inferred from prose.
 */
export function validationRecord(content: string, path: string): GateResult<ValidationGateData> {
  const fm = frontmatterOf(content);
  const blockers = fm.blockers_count;
  const verdict = fm.verdict;
  if (typeof blockers !== "number" || !Number.isInteger(blockers) || blockers < 0) {
    return { ok: false, error: `validation ${path}: frontmatter blockers_count must be an integer ≥ 0 (got ${String(blockers)})` };
  }
  if (verdict !== "pass" && verdict !== "fail") {
    return { ok: false, error: `validation ${path}: frontmatter verdict must be 'pass' or 'fail' (got ${String(verdict)})` };
  }
  if (verdict === "pass" && blockers > 0) {
    return { ok: false, error: `validation ${path}: verdict 'pass' contradicts blockers_count ${blockers}` };
  }
  return { ok: true, value: { blockersCount: blockers, verdict } };
}
