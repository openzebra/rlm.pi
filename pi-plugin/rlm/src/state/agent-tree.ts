/**
 * AgentTree — the live model of who is doing what during an RLM run.
 *
 * Nodes form a tree: a `root` orchestrator at depth 0, `llm`/`batch` leaves for sub-LLM calls,
 * and `rlm` nodes for recursive children (which in turn parent their own sub-calls). The engine
 * and bridges mutate the tree; the TUI widget subscribes to `onChange` and re-renders.
 */

export type NodeKind = "root" | "rlm" | "llm" | "batch";
export type NodeStatus = "running" | "done" | "error";

export interface TreeNode {
  id: string;
  parentId?: string;
  kind: NodeKind;
  depth: number;
  label: string;
  model?: string;
  status: NodeStatus;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  tokens: number;
}

export interface NodeInit {
  parentId?: string;
  kind: NodeKind;
  depth: number;
  label: string;
  model?: string;
  detail?: string;
}

export class AgentTree {
  private readonly nodes = new Map<string, TreeNode>();
  private readonly order: string[] = [];
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  add(init: NodeInit): string {
    const id = `n${++this.seq}`;
    this.nodes.set(id, { id, status: "running", startedAt: Date.now(), costUsd: 0, tokens: 0, ...init });
    this.order.push(id);
    this.emit();
    return id;
  }

  end(id: string, status: NodeStatus = "done", detail?: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = status;
    n.endedAt = Date.now();
    if (detail !== undefined) n.detail = detail;
    this.emit();
  }

  addUsage(id: string, costUsd: number, tokens: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.costUsd += costUsd;
    n.tokens += tokens;
    this.emit();
  }

  setDetail(id: string, detail: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.detail = detail;
    this.emit();
  }

  get(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  /** Children of `parentId` (or top-level roots when omitted), in creation order. */
  children(parentId?: string): TreeNode[] {
    return this.order
      .map((id) => this.nodes.get(id)!)
      .filter((n) => n.parentId === parentId);
  }

  /** Rolled-up totals across the whole tree. */
  totals(): { costUsd: number; tokens: number; running: number } {
    let costUsd = 0;
    let tokens = 0;
    let running = 0;
    for (const n of this.nodes.values()) {
      costUsd += n.costUsd;
      tokens += n.tokens;
      if (n.status === "running") running++;
    }
    return { costUsd, tokens, running };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
