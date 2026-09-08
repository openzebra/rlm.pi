/**
 * Workstream A — RunState: the structured execution state Σ_t carried across iterations of a
 * headless run (SKILL.state paper §3).
 *
 * Per step the model receives exactly A_t = (P, Σ_t, O_t) and may propose a patch ΔΣ_t in a
 * fenced ```state block: {"state_patch": {...}}. The runtime validates deterministically
 * (V(ΔΣ_t, Σ_t) — paper §7: validation is runtime-side, never model-side), merges with
 * null-deletion (Σ_{t+1} = Σ_t ⊕ ΔΣ_t — the one merge in util/state-merge.ts), and on
 * rejection rolls back and surfaces the error as the next observation (error-as-observation
 * retry). After `runStateRetryMax` failed patches the tracker DEGRADES to as-built
 * append-only behavior — nothing in here ever throws into the turn loop.
 *
 * Serialization is compact (paper A.4): JSON.stringify(Σ) — no pretty-printing. Caps
 * (RUN_STATE_LIMITS) keep |Σ_t| flat across iterations so per-turn prompt tokens stay flat.
 */

import { type Result, err, formatError, ok } from "../util/errors.ts";
import { isRecord } from "../util/type-guards.ts";
import type { StateFenceResult } from "../text/parsing.ts";
import type { RlmConfig } from "./types.ts";
import { SKILL_RECALL_LINE } from "../prompts/glossary.ts";

/** Outcome of a tried approach — closed union, no boolean flags. */
export type ApproachOutcome =
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "partial"; readonly note: string }
  | { readonly status: "succeeded"; readonly evidence: string };

/** RunState — the sufficient statistic carried across iterations. Compact-serialized. */
export interface RunState {
  readonly task: string; // invariant restatement (≤200 chars)
  readonly findings: readonly string[]; // verified discoveries (dedup by claim key)
  readonly verifiedFacts: readonly string[]; // grounding facts: paths/symbols/configs
  readonly testedApproaches: Readonly<Record<string, ApproachOutcome>>;
  readonly artifacts: Readonly<Record<string, string>>; // name → REPL variable holding it
  readonly openQuestions: readonly string[];
  readonly nextStep: string;
  /** Iteration counter (not wall clock) — runtime-stamped; the model can never set it. */
  readonly updatedAt: number;
}

/** Model-proposed patch: exactly this shape inside a fenced ```state block (paper §3.2). */
export interface StatePatch {
  readonly state_patch: Readonly<Record<string, unknown>>;
}

/** Anti-bloat caps (§6.1): |Σ_t| never exceeds `bytesTotal` (≈3K tokens worst case), keeping
 *  per-turn prompt tokens flat. Eviction is deterministic: arrays drop oldest-first, records
 *  drop oldest-inserted (write refreshes insertion order = last-mention order). */
export const RUN_STATE_LIMITS = Object.freeze({
  findings: 12,
  verifiedFacts: 16,
  testedApproaches: 24,
  artifacts: 8,
  openQuestions: 8,
  bytesTotal: 12_000,
  /** Per-turn patch byte cap (bench campaign rec #1): oversized `state_patch` fences are
   *  rejected whole with error-as-observation feedback — the model must commit deltas,
   *  not restate Σ. Quantifies the oolong ×5.4 output tax from verbose patches. */
  patchBytes: 1_500,
});

/** Bench campaign rec #2: after this many consecutive fence-requested turns with zero
 *  accepted deltas the run auto-degrades to as-built — an idle Σ is pure input tax on
 *  every prompt (weak-model fence tax, paper §5.7, live-confirmed by the bench). */
export const RUN_STATE_IDLE_DEGRADE_TURNS = 4;

export type PatchError =
  | { readonly kind: "schema"; readonly detail: string }
  | { readonly kind: "type"; readonly path: string; readonly expected: string }
  | { readonly kind: "implicit-drop"; readonly path: string } // small-model guard (§5.7)
  | { readonly kind: "cap"; readonly field: string };

/** Degradation state machine (§6.6) — discriminated union, no boolean flags. `retries`
 *  counts rejected patches (retry-cap degrade); `idle` counts consecutive fence-requested
 *  turns with zero accepted deltas (idle degrade, bench rec #2). */
export type RunStateMode =
  | {
      readonly kind: "active";
      readonly state: RunState;
      readonly retries: number;
      readonly idle: number;
    }
  | { readonly kind: "degraded"; readonly reason: string };

/** Mutable working shape — the runtime draft patches apply to before capping/freezing.
 *  Exported so the root tracker (core/root-state.ts) builds on the exact same shape. */
export interface MutableState {
  task: string;
  nextStep: string;
  updatedAt: number;
  findings: string[];
  verifiedFacts: string[];
  openQuestions: string[];
  testedApproaches: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}

const RUN_STATE_FIELDS: ReadonlySet<string> = new Set([
  "task",
  "findings",
  "verifiedFacts",
  "testedApproaches",
  "artifacts",
  "openQuestions",
  "nextStep",
  "updatedAt",
]);
const ARRAY_FIELDS: ReadonlySet<string> = new Set(["findings", "verifiedFacts", "openQuestions"]);
const TASK_MAX_CHARS = 200;
const NEXT_STEP_MAX_CHARS = 300;
// `findings` | `findings[+]` | `findings[2]` | `testedApproaches.h1`
const PATCH_KEY = /^([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(\[\+\]|\[\d+\])?$/;

export function freshRunState(task: string): RunState {
  return {
    task,
    findings: [],
    verifiedFacts: [],
    testedApproaches: {},
    artifacts: {},
    openQuestions: [],
    nextStep: "",
    updatedAt: 0,
  };
}

/** Compact serialization (paper A.4) — the byte budget `bytesTotal` defends. */
export function compactJSON(state: RunState): string {
  return JSON.stringify(state);
}

export function isRunState(value: unknown): value is RunState {
  if (!isRecord(value)) return false;
  if (typeof value.task !== "string" || typeof value.nextStep !== "string") return false;
  if (typeof value.updatedAt !== "number") return false;
  for (const field of ["findings", "verifiedFacts", "openQuestions"]) {
    if (!isStringArray(value[field])) return false;
  }
  if (!isRecord(value.testedApproaches) || !isRecord(value.artifacts)) return false;
  return Object.values(value.testedApproaches).every((v) => isApproachOutcome(v));
}

export function isStatePatch(value: unknown): value is StatePatch {
  return isRecord(value) && isRecord(value.state_patch);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isApproachOutcome(value: unknown): value is ApproachOutcome {
  if (!isRecord(value)) return false;
  if (value.status === "failed") return typeof value.reason === "string";
  if (value.status === "partial") return typeof value.note === "string";
  if (value.status === "succeeded") return typeof value.evidence === "string";
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/** Trim + casefold + whitespace collapse — the dedup key for array claims. */
function claimKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Order-preserving dedup by claim key — shared by the engine caps path and the root tracker. */
export function dedupStrings(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const key = claimKey(s);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function firstKey(record: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(record)) return key;
  return undefined;
}

/**
 * Whole-record strict merge with implicit-key-drop rejection (paper §5.7: 68% of small-model
 * failures are premature key overwrites). A key present in `prev` but absent from `patch` is
 * an ERROR, not a silent keep — deletion must be explicit (`null`). Incremental updates use
 * dotted paths instead, which never hit this check.
 */
function strictMergeRecord(
  prev: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  path: string,
): Result<Record<string, unknown>, PatchError> {
  for (const key of Object.keys(prev)) {
    if (!(key in patch)) return err({ kind: "implicit-drop", path: `${path}.${key}` });
  }
  const out: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- ⊕ explicit null = delete (paper §3.2)
      delete out[key]; // explicit delete
      continue;
    }
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      const nested = strictMergeRecord(current, value, `${path}.${key}`);
      if (!nested.ok) return nested;
      out[key] = nested.value;
    } else {
      out[key] = value;
    }
  }
  return ok(out);
}

/** Evict oldest-inserted entries past a record cap; writes refresh order (last-mention). */
function dropOldestRecord(record: Record<string, unknown>, cap: number): void {
  while (Object.keys(record).length > cap) {
    const oldest = firstKey(record);
    if (oldest === undefined) return;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- deterministic oldest-inserted eviction (§6.1)
    delete record[oldest];
  }
}

function mutableArrayOf(draft: MutableState, field: string): string[] | undefined {
  if (field === "findings") return draft.findings;
  if (field === "verifiedFacts") return draft.verifiedFacts;
  if (field === "openQuestions") return draft.openQuestions;
  return undefined;
}

/** Deterministic caps enforcement — arrays → records → bytesTotal cascade (§6.1).
 *  Shared by the engine patch path and the root tracker (one implementation, DRY). */
export function enforceCaps(draft: MutableState): Result<RunState, PatchError> {
  const findings = dedupStrings(draft.findings);
  const verifiedFacts = dedupStrings(draft.verifiedFacts);
  const openQuestions = dedupStrings(draft.openQuestions);
  while (findings.length > RUN_STATE_LIMITS.findings) findings.shift();
  while (verifiedFacts.length > RUN_STATE_LIMITS.verifiedFacts) verifiedFacts.shift();
  while (openQuestions.length > RUN_STATE_LIMITS.openQuestions) openQuestions.shift();
  dropOldestRecord(draft.testedApproaches, RUN_STATE_LIMITS.testedApproaches);
  dropOldestRecord(draft.artifacts, RUN_STATE_LIMITS.artifacts);
  const capped: MutableState = {
    task: draft.task,
    nextStep: draft.nextStep,
    updatedAt: draft.updatedAt,
    findings,
    verifiedFacts,
    openQuestions,
    testedApproaches: { ...draft.testedApproaches },
    artifacts: { ...draft.artifacts },
  };
  // bytesTotal: |Σ_t| must never exceed κ_Σ — deterministic eviction order keeps runs flat.
  let guard = 0;
  while (JSON.stringify(capped).length > RUN_STATE_LIMITS.bytesTotal && guard++ < 10_000) {
    if (capped.findings.length > 0) {
      capped.findings = capped.findings.slice(1);
      continue;
    }
    if (capped.verifiedFacts.length > 0) {
      capped.verifiedFacts = capped.verifiedFacts.slice(1);
      continue;
    }
    if (capped.openQuestions.length > 0) {
      capped.openQuestions = capped.openQuestions.slice(1);
      continue;
    }
    const approach = firstKey(capped.testedApproaches);
    if (approach !== undefined) {
      const rest = { ...capped.testedApproaches };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cap eviction (§6.1)
      delete rest[approach];
      capped.testedApproaches = rest;
      continue;
    }
    const artifact = firstKey(capped.artifacts);
    if (artifact !== undefined) {
      const rest = { ...capped.artifacts };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cap eviction (§6.1)
      delete rest[artifact];
      capped.artifacts = rest;
      continue;
    }
    return err({ kind: "cap", field: "bytesTotal" });
  }
  // Guard over cast: every write path validated entry shapes, but the record index types
  // widened during mutation — re-narrow deterministically before handing Σ back.
  const finalized: unknown = capped;
  if (!isRunState(finalized)) {
    return err({ kind: "schema", detail: "post-cap state failed validation" });
  }
  return ok(finalized);
}

/** Apply one patch key (dotted path + optional array op) to the mutable draft. */
function applyKey(draft: MutableState, rawKey: string, value: unknown): Result<null, PatchError> {
  const m = PATCH_KEY.exec(rawKey);
  if (m === null) return err({ kind: "schema", detail: `malformed patch key "${rawKey}"` });
  const root = m[1];
  if (!RUN_STATE_FIELDS.has(root)) {
    return err({ kind: "schema", detail: `unknown state field "${root}"` });
  }
  if (root === "updatedAt") {
    return err({ kind: "schema", detail: "updatedAt is runtime-stamped and cannot be patched" });
  }
  const middles = m[2] === "" ? [] : m[2].slice(1).split(".");
  const op = m[3];

  // Scalars: task / nextStep — string replace with a length cap.
  if (middles.length === 0 && (root === "task" || root === "nextStep")) {
    if (typeof value !== "string") {
      return err({ kind: "type", path: rawKey, expected: "string" });
    }
    const cap = root === "task" ? TASK_MAX_CHARS : NEXT_STEP_MAX_CHARS;
    if (value.length > cap) return err({ kind: "cap", field: root });
    if (root === "task") draft.task = value;
    else draft.nextStep = value;
    return ok(null);
  }

  // Arrays (top level only): full replace, `[+]` append, or `[N]` set.
  if (middles.length === 0 && ARRAY_FIELDS.has(root)) {
    const list = arrayOf(draft, root);
    if (list === undefined) {
      return err({ kind: "schema", detail: `unknown array field "${root}"` });
    }
    if (op === "[+]") {
      if (typeof value !== "string") return err({ kind: "type", path: rawKey, expected: "string" });
      list.push(value);
    } else if (op !== undefined) {
      const index = Number.parseInt(op.slice(1, -1), 10);
      if (value === null) {
        // Explicit delete by index (must not leave a hole).
        if (index >= list.length) {
          return err({ kind: "schema", detail: `${rawKey} out of range (len=${list.length})` });
        }
        list.splice(index, 1);
        return ok(null);
      }
      if (typeof value !== "string") return err({ kind: "type", path: rawKey, expected: "string" });
      if (index > list.length) {
        return err({ kind: "schema", detail: `${rawKey} would leave a hole (len=${list.length})` });
      }
      list[index] = value;
    } else {
      if (!isStringArray(value)) return err({ kind: "type", path: rawKey, expected: "string[]" });
      list.length = 0;
      list.push(...dedupStrings(value));
    }
    return ok(null);
  }

  // Records: `testedApproaches` / `artifacts`.
  if (!isRecordField(root)) {
    return err({ kind: "schema", detail: `field "${root}" takes no sub-paths` });
  }
  if (middles.length === 0 && op !== undefined) {
    return err({ kind: "type", path: rawKey, expected: "object (records use dotted keys)" });
  }
  if (middles.length === 0) {
    // Whole-record patch — strict merge, implicit drops rejected (§5.7 guard).
    if (value === null) {
      if (root === "testedApproaches") draft.testedApproaches = {};
      else draft.artifacts = {};
      return ok(null);
    }
    if (!isPlainObject(value)) return err({ kind: "type", path: rawKey, expected: "object" });
    const prev = root === "testedApproaches" ? draft.testedApproaches : draft.artifacts;
    const merged = strictMergeRecord(prev, value, root);
    if (!merged.ok) return merged;
    if (root === "testedApproaches") draft.testedApproaches = merged.value;
    else draft.artifacts = merged.value;
    return ok(null);
  }
  if (op !== undefined) {
    return err({ kind: "schema", detail: `array ops are not valid inside record "${root}"` });
  }
  // Dotted entry write: create-or-replace one entry; null deletes it.
  const record: Record<string, unknown> =
    root === "testedApproaches" ? { ...draft.testedApproaches } : { ...draft.artifacts };
  let cursor = record;
  for (let i = 0; i < middles.length - 1; i++) {
    const segment = middles[i];
    const next: unknown = cursor[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    if (!isPlainObject(next)) {
      return err({ kind: "type", path: rawKey, expected: "object" });
    }
    cursor = next;
  }
  const leaf = middles[middles.length - 1];
  if (value === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- ⊕ null = delete (paper §3.2)
    delete cursor[leaf];
    commitRecord(draft, root, record);
    return ok(null);
  }
  if (root === "testedApproaches") {
    if (!isPlainObject(value) || !isApproachOutcome(value)) {
      return err({ kind: "type", path: rawKey, expected: "ApproachOutcome" });
    }
    const prev: unknown = cursor[leaf];
    const merged = isPlainObject(prev)
      ? strictMergeRecord(prev, value, rawKey)
      : ok<Record<string, unknown>, PatchError>({ ...value });
    if (!merged.ok) return merged;
    refreshOrder(cursor, leaf, merged.value); // last-mention ordering for eviction
  } else {
    if (typeof value !== "string") return err({ kind: "type", path: rawKey, expected: "string" });
    refreshOrder(cursor, leaf, value);
  }
  commitRecord(draft, root, record);
  return ok(null);
}

function isRecordField(root: string): root is "testedApproaches" | "artifacts" {
  return root === "testedApproaches" || root === "artifacts";
}

function arrayOf(draft: MutableState, root: string): string[] | undefined {
  return mutableArrayOf(draft, root);
}

function commitRecord(draft: MutableState, root: "testedApproaches" | "artifacts", record: Record<string, unknown>): void {
  if (root === "testedApproaches") draft.testedApproaches = record;
  else draft.artifacts = record;
}

/** Rewrite a record entry so its insertion order reflects the latest mention. */
function refreshOrder(record: Record<string, unknown>, key: string, value: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- last-mention insertion-order refresh (§6.1)
  delete record[key];
  record[key] = value;
}

/**
 * V(ΔΣ_t, Σ_t) → Result<Σ_{t+1}, PatchError> — the deterministic, runtime-side validator
 * (paper §7). Invalid patches never touch the previous state (rollback is structural: the
 * draft is discarded). `t` stamps `updatedAt` (iteration counter).
 */
export function applyPatch(prev: RunState, patch: unknown, t: number): Result<RunState, PatchError> {
  if (!isStatePatch(patch)) {
    return err({ kind: "schema", detail: 'patch must be {"state_patch": {...}}' });
  }
  const ops = Object.entries(patch.state_patch);
  if (ops.length === 0) return err({ kind: "schema", detail: "empty state_patch" });
  // Per-turn byte cap (bench rec #1): reject BEFORE the draft clone — a verbose restatement
  // must come back as an error observation, never silently eat output tokens.
  if (JSON.stringify(patch).length > RUN_STATE_LIMITS.patchBytes) {
    return err({ kind: "cap", field: "patchBytes" });
  }
  // JSON round-trip clone: RunState is JSON-safe by construction and stays well under κ_Σ.
  const draft = JSON.parse(JSON.stringify(prev)) as MutableState;
  for (const [key, value] of ops) {
    const applied = applyKey(draft, key, value);
    if (!applied.ok) return applied;
  }
  draft.updatedAt = t;
  return enforceCaps(draft);
}

/** Human-facing patch rejection — becomes the next O_t prefix (error-as-observation). */
export function patchErrorText(error: PatchError): string {
  switch (error.kind) {
    case "schema":
      return `schema violation: ${error.detail}`;
    case "type":
      return `type mismatch at "${error.path}" (expected ${error.expected})`;
    case "implicit-drop":
      return `implicit key drop at "${error.path}" — restate the key or delete it with null`;
    case "cap":
      return `cap exceeded on "${error.field}"`;
  }
}

/**
 * Apply every ```state fence found in a turn response, in document order, to an ACTIVE mode.
 * Rejections accumulate into one observation (the next O_t prefix); once failures exceed
 * `runStateRetryMax` the mode DEGRADES — the engine then behaves exactly as built.
 *
 * Idle degrade (bench rec #2): when `fenceRequested` is true (the turn conditioned on Σ)
 * and zero patches were accepted, the turn is IDLE — Σ inflated the prompt for nothing.
 * `RUN_STATE_IDLE_DEGRADE_TURNS` consecutive idle turns degrade, same as-built outcome.
 */
export function applyStatePatches(
  mode: Extract<RunStateMode, { kind: "active" }>,
  parsed: readonly StateFenceResult[],
  iteration: number,
  config: Pick<RlmConfig, "runStateRetryMax">,
  fenceRequested = false,
): { readonly mode: RunStateMode; readonly observation: string | undefined } {
  // Identity fast-path: a fence-free turn on a run that never asked for fences changes
  // nothing — keep the same mode object (callers may compare identity).
  if (parsed.length === 0 && !fenceRequested) return { mode, observation: undefined };
  let state = mode.state;
  let retries = mode.retries;
  let accepted = 0;
  const problems: string[] = [];
  for (const fence of parsed) {
    if (!fence.ok) {
      retries += 1;
      problems.push(malformedFenceProblem(fence.error));
      continue;
    }
    const result = applyPatch(state, fence.value, iteration);
    if (result.ok) {
      state = result.value;
      accepted += 1;
    } else {
      retries += 1;
      problems.push(patchErrorText(result.error));
    }
  }
  // Bench rec #2: accepted deltas reset the idle streak; a requested-but-empty turn grows it.
  const idle = accepted > 0 || !fenceRequested ? 0 : mode.idle + 1;
  let nextMode: RunStateMode = { kind: "active", state, retries, idle };
  if (retries > config.runStateRetryMax) {
    nextMode = {
      kind: "degraded",
      reason: `runStateRetryMax exceeded (${retries} rejected state patches)`,
    };
  } else if (idle >= RUN_STATE_IDLE_DEGRADE_TURNS) {
    nextMode = {
      kind: "degraded",
      reason: `idle degrade — ${idle} consecutive fence-requested turns with zero accepted deltas`,
    };
  }
  return { mode: nextMode, observation: statePatchObservation(problems) };
}

/** Problem entry for an unparsable fence body — shared by both fence loops (one wording). */
export function malformedFenceProblem(error: string): string {
  return `malformed \`\`\`state fence (${error})`;
}

/** ONE wording source for patch-rejection observations — engine turns AND root fences. */
export function statePatchObservation(problems: readonly string[]): string | undefined {
  return problems.length === 0
    ? undefined
    : `${formatError(`state patch rejected — rolled back (${problems.join("; ")})`)}\n` +
      "Fix the ```state fence and re-commit; the raw observation will not be shown again.";
}

export const STATE_FENCE_INSTRUCTION: string =
  "[state] Your user-facing reply is normal prose — a readable report. The ```state fence is OPTIONAL compact metadata that trails it, never a replacement for the report:\n" +
  '{"state_patch": {"verifiedFacts[+]": "src/x.ts — fact", "testedApproaches.h1.status": "failed"}}\n' +
  "Σ is an index of pointers, not a report: ≤ 5 keys per patch, every string value ≤ 120 chars, " +
  "telegraphic style (`path — fact`, `verdict — numbers`). NEVER paste findings, tables, JSON " +
  "blobs, or long excerpts into Σ — the prose carries the story, Σ carries only the pointers.\n" +
  "Keys: dotted paths write record leaves; [+] appends; [N] sets an array slot; null deletes.\n" +
  "Commit DELTAS only — never restate unchanged records or arrays; touch single dotted keys " +
  `or append with [+]. Whole-record restatements must keep EVERY key (implicit drops are ` +
  `rejected), and a patch over ${RUN_STATE_LIMITS.patchBytes} bytes is rejected whole.\n` +
  "If this turn produced nothing durable and new, end your reply on the prose — NO fence at all. " +
  "An absent fence is free; a malformed or oversized one costs a retry. " +
  "Stale turns are elided and compensated by Σ, so a durable fact you skip here is gone.";

/** ONE Σ-block composer (R2): the engine turn block and the root splice both delegate here —
 *  never duplicate the contract + Σ assembly. `withContract` is paper A.4 authoring mode;
 *  without it, observation-only mode. */
function sigmaBlock(state: RunState, withContract: boolean): string {
  const sigma = `[Σ] ${compactJSON(state)}`;
  return withContract ? `${STATE_FENCE_INSTRUCTION}\n\n${sigma}` : sigma;
}

/** The per-turn A_t block: the fence contract + the current Σ (paper A_t = (P, Σ_t, O_t)). */
export function runStateTurnBlock(state: RunState): string {
  return sigmaBlock(state, true);
}

/**
 * Root Σ (WS-3b): the ROOT's A_t block. R2 (G2): with `withContract` the splice carries the
 * SAME fence contract (delegating to the one composer above — no re-wording), making the
 * splice paper-faithful A.4 authoring mode; without it, byte-identical to the v1
 * observation-only snapshot. Recall line comes from the glossary (one wording source).
 */
export function runStateRootBlock(state: RunState, opts?: { readonly withContract?: boolean }): string {
  return sigmaBlock(state, opts?.withContract === true) +
    "\n" +
    "Fresh tool results outrank Σ when they disagree.\n" +
    `[Project facts recall: skill_search()] — ${SKILL_RECALL_LINE}`;
}
