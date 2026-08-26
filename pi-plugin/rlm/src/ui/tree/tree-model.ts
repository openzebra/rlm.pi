/**
 * tree-model — pure projection of one run's subcall state into display rows.
 *
 * No TUI imports, no side effects: same inputs → same rows. The widget caches
 * the result and only rebuilds when the underlying store reports a change.
 *
 * Nothing is ever hidden: every sub-call renders as its own row (parity with
 * pi, which shows each concurrent tool call individually) — except runs of
 * IDENTICAL sibling leaves (same label+model+status), which collapse into one
 * expandable "label ×N" group row so a 20-item llm_batch is one line, not 20.
 * Error leaves are NEVER grouped — each keeps its own row and reason.
 * Collapsed subtrees are skipped at the user's explicit request (chevron flips).
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

export type TreeRow = NodeRow | GroupRow;

/** A run of identical sibling leaves (label+model+status) shown as one row. */
export interface GroupRow {
  readonly type: "group";
  /** Synthetic id — "grp:" prefix keeps it disjoint from subcall ids. */
  readonly id: string;
  readonly runId: string;
  readonly depth: number;
  readonly prefix: string;
  readonly count: number;
  readonly label: string;
  readonly model?: string;
  /** Sum over members — one model only (the group key pins it), so never a blend. */
  readonly tokens: number;
  readonly icon: SubcallStatus;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** Internal build-time entry: a real node or an accumulating group. */
type Entry =
  | { readonly type: "node"; readonly sc: RlmSubcall }
  | { readonly type: "group"; readonly key: string; readonly label: string; readonly model?: string; readonly status: SubcallStatus; readonly members: RlmSubcall[] };

/** Errors never group — each keeps its own row and its own reason. */
const groupable = (sc: RlmSubcall, byParent: ReadonlyMap<string | undefined, RlmSubcall[]>): boolean =>
  sc.kind === "llm" && sc.status !== "error" && (byParent.get(sc.id)?.length ?? 0) === 0;

const groupKey = (sc: RlmSubcall): string => `${sc.label}|${sc.model ?? ""}|${sc.status}`;

/** Merge consecutive identical sibling leaves into group entries; keep order. */
function partition(children: readonly RlmSubcall[], byParent: ReadonlyMap<string | undefined, RlmSubcall[]>): readonly Entry[] {
  const out: Entry[] = [];
  for (const sc of children) {
    if (groupable(sc, byParent)) {
      const key = groupKey(sc);
      const last = out[out.length - 1];
      if (last !== undefined && last.type === "group" && last.key === key) {
        last.members.push(sc);
        continue;
      }
      out.push({ type: "group", key, label: sc.label, model: sc.model, status: sc.status, members: [sc] });
    } else {
      out.push({ type: "node", sc });
    }
  }
  return out;
}

/** RlmRunStatus has "aborted"; the row icon set does not — aborted renders as error. */
function iconOf(status: SubcallStatus | RlmRunStatus): SubcallStatus {
  return status === "aborted" ? "error" : status;
}

/**
 * Flatten a run snapshot into visible rows. Depth-first, children ordered by
 * startedAt. Pure: allocates fresh arrays, never mutates the snapshot.
 */
export function buildRows(
  run: RunSnapshot,
  collapsed: ReadonlySet<string>,
  expandedGroups: ReadonlySet<string> = new Set(),
): readonly TreeRow[] {
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
    const entries = partition(children, byParent);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      const isLast = i === entries.length - 1;
      const prefix = `${guide}${isLast ? "└─ " : "├─ "}`;
      const childGuide = `${guide}${isLast ? "   " : "│  "}`;
      if (entry.type === "node") visit(entry.sc, parentDepth + 1, prefix, childGuide);
      else if (entry.members.length === 1) {
        // A single identical leaf is not a group — render it as the plain row it is.
        const only = entry.members[0];
        if (only !== undefined) visit(only, parentDepth + 1, prefix, childGuide);
      } else visitGroup(entry, parentDepth + 1, prefix, childGuide);
    }
  };

  const visitGroup = (
    entry: Extract<Entry, { type: "group" }>,
    depth: number,
    prefix: string,
    guide: string,
  ): void => {
    const first = entry.members[0];
    if (first === undefined) return;
    const id = `grp:${run.runId}:${entry.key}:${first.id}`;
    const expanded = expandedGroups.has(id);
    let tokens = 0;
    for (const m of entry.members) tokens += m.tokens;
    rows.push({
      type: "group",
      id,
      runId: run.runId,
      depth,
      prefix,
      count: entry.members.length,
      label: entry.label,
      model: entry.model,
      tokens,
      icon: iconOf(entry.status),
      expandable: true,
      expanded,
    });
    if (!expanded) return;
    for (let i = 0; i < entry.members.length; i++) {
      const member = entry.members[i];
      if (member === undefined) continue;
      const last = i === entry.members.length - 1;
      visit(member, depth, `${guide}${last ? "└─ " : "├─ "}`, `${guide}${last ? "   " : "│  "}`);
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
