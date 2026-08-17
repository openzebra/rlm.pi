/**
 * tree-model — pure projection of one run's subcall state into display rows.
 *
 * No TUI imports, no side effects: same inputs → same rows. The widget caches
 * the result and only rebuilds when the underlying store reports a change.
 *
 * Row model is a discriminated union: real nodes ("node") and synthesized
 * "… ×N more" markers ("overflow") when a parent has more children than the
 * per-parent cap. Collapsed subtrees are skipped entirely (chevron flips).
 */

import type { RlmSubcall, RlmRunStatus, SubcallPhase, SubcallStatus } from "../../tool/rlm-details.ts";

export const TREE_LIMITS = Object.freeze({
  /** Direct children shown per parent before an overflow marker row. */
  maxChildrenPerParent: 5,
  /** Hard cap on total rows so the widget never eats the screen. */
  maxRows: 24,
} as const);

/** Immutable per-run view the model consumes (built by RunRegistry from a live store). */
export interface RunSnapshot {
  readonly runId: string;
  /** Root row label — prompt preview or "repl". */
  readonly rootLabel: string;
  readonly status: RlmRunStatus;
  readonly rootPhase?: SubcallPhase;
  /** Whole-run tokens (root usage + every subcall). */
  readonly tokens: number;
  readonly subcalls: readonly RlmSubcall[];
}

export interface NodeRow {
  readonly type: "node";
  /** Subcall id, or the run id for the synthetic root row. */
  readonly id: string;
  /** Owning run — the modal resolves its timeline through this. */
  readonly runId: string;
  readonly depth: number;
  /** Tree guide prefix, e.g. "│  ├─ " — formatter stays dumb. */
  readonly prefix: string;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly icon: SubcallStatus;
  readonly phase?: SubcallPhase;
  readonly label: string;
  /** Subtree token sum for containers (run/rlm), own tokens for leaves. */
  readonly tokens: number;
  readonly model?: string;
}

export interface OverflowRow {
  readonly type: "overflow";
  readonly depth: number;
  readonly prefix: string;
  readonly count: number;
}

export type TreeRow = NodeRow | OverflowRow;

/** RlmRunStatus has "aborted"; the row icon set does not — aborted renders as error. */
function iconOf(status: SubcallStatus | RlmRunStatus): SubcallStatus {
  return status === "aborted" ? "error" : status;
}

function labelOf(sc: RlmSubcall): string {
  // Batch nodes read "llm_batch ×20" — one row, honest count.
  return sc.totalCount !== undefined && sc.totalCount > 1 ? `${sc.label} ×${sc.totalCount}` : sc.label;
}

/**
 * Flatten a run snapshot into visible rows. Depth-first, children ordered by
 * startedAt, per-parent overflow cap, global row cap. Pure: allocates fresh
 * arrays, never mutates the snapshot.
 */
export function buildRows(run: RunSnapshot, collapsed: ReadonlySet<string>): readonly TreeRow[] {
  const byParent = new Map<string | undefined, RlmSubcall[]>();
  for (const sc of run.subcalls) {
    const siblings = byParent.get(sc.parentId);
    if (siblings === undefined) byParent.set(sc.parentId, [sc]);
    else siblings.push(sc);
  }
  // Containers (agents) sort before leaves so the overflow cap hides llm rows,
  // never a whole agent; within a group, stable by start time.
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => Number((byParent.get(b.id)?.length ?? 0) > 0) - Number((byParent.get(a.id)?.length ?? 0) > 0) || a.startedAt - b.startedAt);
  }

  // Subtree token sums, memoized post-order — containers show their whole spend.
  const tokenSums = new Map<string, number>();
  const sumTokens = (sc: RlmSubcall): number => {
    const memo = tokenSums.get(sc.id);
    if (memo !== undefined) return memo;
    let sum = sc.tokens;
    for (const child of byParent.get(sc.id) ?? []) sum += sumTokens(child);
    tokenSums.set(sc.id, sum);
    return sum;
  };

  const rows: TreeRow[] = [];
  const roots = byParent.get(undefined) ?? [];

  const visit = (sc: RlmSubcall, depth: number, prefix: string, childGuide: string): void => {
    if (rows.length >= TREE_LIMITS.maxRows) return;
    const children = byParent.get(sc.id) ?? [];
    const expanded = !collapsed.has(sc.id);
    rows.push({
      type: "node",
      id: sc.id,
      runId: run.runId,
      depth,
      prefix,
      expandable: children.length > 0,
      expanded,
      icon: iconOf(sc.status),
      phase: sc.phase,
      label: labelOf(sc),
      tokens: children.length > 0 ? sumTokens(sc) : sc.tokens,
      model: sc.model,
    });
    if (!expanded || children.length === 0) return;
    visitChildren(children, depth, childGuide);
  };

  const visitChildren = (children: readonly RlmSubcall[], parentDepth: number, guide: string): void => {
    const cap = TREE_LIMITS.maxChildrenPerParent;
    const visible = children.length > cap ? children.slice(0, cap - 1) : children;
    const hidden = children.length - visible.length;
    for (let i = 0; i < visible.length; i++) {
      const child = visible[i];
      if (child === undefined) continue;
      const isLast = i === visible.length - 1 && hidden === 0;
      visit(child, parentDepth + 1, `${guide}${isLast ? "└─ " : "├─ "}`, `${guide}${isLast ? "   " : "│  "}`);
    }
    if (hidden > 0 && rows.length < TREE_LIMITS.maxRows) {
      rows.push({ type: "overflow", depth: parentDepth + 1, prefix: `${guide}   `, count: hidden });
    }
  };

  // Synthetic root row for the run itself.
  rows.push({
    type: "node",
    id: run.runId,
    runId: run.runId,
    depth: 0,
    prefix: "",
    expandable: roots.length > 0,
    expanded: !collapsed.has(run.runId),
    icon: iconOf(run.status),
    phase: run.rootPhase,
    label: run.rootLabel,
    tokens: run.tokens,
    model: undefined,
  });
  if (!collapsed.has(run.runId)) visitChildren(roots, 0, "");

  return Object.freeze(rows);}
