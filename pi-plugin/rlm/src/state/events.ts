/**
 * SubcallObserver decouples the bridges/engine from the AgentTree: they report sub-call
 * lifecycle through this small interface, and `treeObserver` maps it onto tree nodes. Tests can
 * pass a no-op (or recording) observer instead.
 */

import type { TelemetrySink } from "../telemetry/sink.ts";
import { AgentTree, type NodeKind } from "./agent-tree.ts";

export interface SubcallStart {
  kind: NodeKind;
  depth: number;
  parentId?: string;
  model?: string;
  label: string;
  detail?: string;
  args?: string;
}

export interface SubcallObserver {
  start(info: SubcallStart): string;
  end(id: string, opts?: { error?: string; costUsd?: number; tokens?: number; resultPreview?: string }): void;
  /** Account usage to an existing node (e.g. a root turn). */
  usage(id: string, costUsd: number, tokens: number): void;
  /** Update a node's one-line detail (e.g. "turn 3/30"). */
  detail(id: string, text: string): void;
  /** Update the current action/code preview for a running node. */
  action(id: string, args: string): void;
  /** Update the current result/stdout preview for a running node. */
  result(id: string, text: string): void;
}

export const NOOP_OBSERVER: SubcallObserver = {
  start: () => "",
  end: () => {},
  usage: () => {},
  detail: () => {},
  action: () => {},
  result: () => {},
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
        args: info.args,
      }),
    end: (id, opts) => {
      if (!id) return;
      if (opts?.costUsd || opts?.tokens) tree.addUsage(id, opts.costUsd ?? 0, opts.tokens ?? 0);
      if (opts?.resultPreview) tree.setResult(id, opts.resultPreview);
      tree.end(id, opts?.error ? "error" : "done", opts?.error);
    },
    usage: (id, costUsd, tokens) => {
      if (id) tree.addUsage(id, costUsd, tokens);
    },
    detail: (id, text) => {
      if (id) tree.setDetail(id, text);
    },
    action: (id, args) => {
      if (id) tree.setArgs(id, args);
    },
    result: (id, text) => {
      if (id) tree.setResult(id, text);
    },
  };
}

export function observerWith(tree: AgentTree, sink?: TelemetrySink): SubcallObserver {
  const base = treeObserver(tree);
  if (!sink) return base;
  return {
    start: (info) => {
      const id = base.start(info);
      sink.start(id, info);
      return id;
    },
    end: (id, opts) => {
      base.end(id, opts);
      if (!id) return;
      if (opts?.costUsd || opts?.tokens) sink.usage(id, opts.costUsd ?? 0, opts.tokens ?? 0);
      sink.end(id, { error: opts?.error, resultPreview: opts?.resultPreview });
    },
    usage: (id, costUsd, tokens) => {
      base.usage(id, costUsd, tokens);
      sink.usage(id, costUsd, tokens);
    },
    detail: base.detail,
    action: base.action,
    result: base.result,
  };
}
