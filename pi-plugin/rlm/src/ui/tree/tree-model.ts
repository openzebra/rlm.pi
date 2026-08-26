/**
 * tree-model — pure projection of one run's subcall state into display rows.
 *
 * No TUI imports, no side effects: same inputs → same rows. The widget caches
 * the result and only rebuilds when the underlying store reports a change.
 *
 * Nothing is ever hidden: every subcall renders as its own row (parity with
 * pi, which shows each concurrent tool call individually). Collapsed subtrees
 * are skipped at the user's explicit request (chevron flips).
 * Token rows are own-spend only — a row never blends models.
 */

import type { RlmSubcall, RlmRunStatus, SubcallPhase, SubcallStatus } from "../../tool/rlm-details.ts";

/** Immutable per-run view the model consumes (built by RunRegistry from a live store). */
export interface RunSnapshot {
  readonly runId: string;
  /** Root row label — prompt preview or "repl". */
  readonly rootLabel: string;
  readonly status: RlmRunStatus;
  readonly rootPhase?: SubcallPhase;
  /** Root's OWN model ("provider/id") — the default/session model driving the run. */
  readonly rootModel?: string;
  /** Root's OWN token spend (driver-model turns) — never a subtree sum. */
  readonly rootTokens: number;
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
  /** The row's OWN token spend for its OWN model — never a subtree sum. */
  readonly tokens: number;
  readonly model?: string;
}

export type TreeRow = NodeRow;

/** RlmRunStatus has "aborted"; the row icon set does not — aborted renders as error. */
function iconOf(status: SubcallStatus | RlmRunStatus): SubcallStatus {
  return status === "aborted" ? "error" : status;
}

/**
 * Flatten a run snapshot into visible rows. Depth-first, children ordered by
 * startedAt. Pure: allocates fresh arrays, never mutates the snapshot.
 */
export function buildRows(run: RunSnapshot, collapsed: ReadonlySet<string>): readonly TreeRow[] {
  const byParent = new Map<string | undefined, RlmSubcall[]>();
  for (const sc of run.subcalls) {
    const siblings = byParent.get(sc.parentId);
    if (siblings === undefined) byParent.set(sc.parentId, [sc]);
    else siblings.push(sc);
  }
  // Containers (agents) sort before leaves so agent rows stay adjacent; within
  // a group, stable by start time.
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => Number((byParent.get(b.id)?.length ?? 0) > 0) - Number((byParent.get(a.id)?.length ?? 0) > 0) || a.startedAt - b.startedAt);
  }

  const rows: TreeRow[] = [];
  const roots = byParent.get(undefined) ?? [];

  const visit = (sc: RlmSubcall, depth: number, prefix: string, childGuide: string): void => {
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
      label: sc.label,
      tokens: sc.tokens,
      model: sc.model,
    });
    if (!expanded || children.length === 0) return;
    visitChildren(children, depth, childGuide);
  };

  const visitChildren = (children: readonly RlmSubcall[], parentDepth: number, guide: string): void => {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === undefined) continue;
      const isLast = i === children.length - 1;
      visit(child, parentDepth + 1, `${guide}${isLast ? "└─ " : "├─ "}`, `${guide}${isLast ? "   " : "│  "}`);
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
    tokens: run.rootTokens,
    model: run.rootModel,
  });
  if (!collapsed.has(run.runId)) visitChildren(roots, 0, "");

  return Object.freeze(rows);
}
