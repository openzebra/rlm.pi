/**
 * SubcallObserver decouples the bridges/engine from the AgentTree: they report sub-call
 * lifecycle through this small interface, and `treeObserver` maps it onto tree nodes. Tests can
 * pass a no-op (or recording) observer instead.
 */

import { AgentTree, type NodeKind } from "./agent-tree.ts";

export interface SubcallStart {
  kind: NodeKind;
  depth: number;
  parentId?: string;
  model?: string;
  label: string;
  detail?: string;
}

export interface SubcallObserver {
  start(info: SubcallStart): string;
  end(id: string, opts?: { error?: string; costUsd?: number; tokens?: number }): void;
  /** Account usage to an existing node (e.g. a root turn). */
  usage(id: string, costUsd: number, tokens: number): void;
  /** Update a node's one-line detail (e.g. "turn 3/30"). */
  detail(id: string, text: string): void;
}

export const NOOP_OBSERVER: SubcallObserver = {
  start: () => "",
  end: () => {},
  usage: () => {},
  detail: () => {},
};

export function treeObserver(tree: AgentTree): SubcallObserver {
  return {
    start: (info) =>
      tree.add({
        parentId: info.parentId,
        kind: info.kind,
        depth: info.depth,
        label: info.label,
        model: info.model,
        detail: info.detail,
      }),
    end: (id, opts) => {
      if (!id) return;
      if (opts?.costUsd || opts?.tokens) tree.addUsage(id, opts.costUsd ?? 0, opts.tokens ?? 0);
      tree.end(id, opts?.error ? "error" : "done", opts?.error);
    },
    usage: (id, costUsd, tokens) => {
      if (id) tree.addUsage(id, costUsd, tokens);
    },
    detail: (id, text) => {
      if (id) tree.setDetail(id, text);
    },
  };
}
