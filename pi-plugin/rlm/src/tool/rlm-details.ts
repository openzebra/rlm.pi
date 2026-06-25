/**
 * RlmDetails — the structured payload for the RLM tool's AgentToolResult<T>.
 *
 * Replaces AgentTree + SubcallObserver. The RlmToolBridge accumulates sub-call
 * lifecycle events into a flat RlmSubcall[] array and calls onUpdate(partialResult)
 * after every mutation, enabling Pi's built-in progressive TUI re-render.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import type { TelemetrySink } from "../telemetry/sink.ts";

export type SubcallKind = "root" | "rlm" | "llm" | "batch" | "tool";
export type SubcallStatus = "running" | "done" | "error";
export type RlmRunStatus = "running" | "done" | "error" | "aborted";

export interface RlmSubcall {
  id: string;
  /** Parent subcall ID for recursive grouping (undefined = direct child of root). */
  parentId?: string;
  kind: SubcallKind;
  label: string;
  model?: string;
  status: SubcallStatus;
  detail?: string;
  args?: string;
  resultPreview?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  tokens: number;
}

export interface RlmDetails {
  status: RlmRunStatus;
  rootPrompt: string;
  turns: { current: number; max: number };
  subcalls: RlmSubcall[];
  totals: { costUsd: number; tokens: number };
  answer?: string;
  edits?: ProposedEdit[];
}

export interface SubcallInit {
  parentId?: string;
  kind: SubcallKind;
  label: string;
  model?: string;
  detail?: string;
  args?: string;
  /** Recursion depth. Threaded from bridge call sites (opts.depth). */
  depth?: number;
}

/**
 * Accumulates sub-call lifecycle events into an RlmDetails payload and calls
 * `onUpdate` after every mutation for progressive TUI re-rendering.
 *
 * Replaces both AgentTree (mutable tree data store) and SubcallObserver
 * (6-method lifecycle interface). The bridge is created once per RLM invocation
 * and shared across the engine and all bridges.
 *
 * For recursive engines (depth > 0): the parent's rlm-query bridge creates a
 * subcall entry before recursing and passes the bridge + subcall ID down.
 * The recursive engine reports its own state via updateSubcall(subId, ...).
 */
export class RlmToolBridge {
  private readonly subcalls = new Map<string, RlmSubcall>();
  private seq = 0;

  // Root-level state (set by the depth-0 engine only)
  private rootStatus: RlmRunStatus = "running";
  private rootPrompt = "";
  private turnCurrent = 0;
  private turnMax = 0;
  private answer?: string;
  private edits?: ProposedEdit[];

  // Incremental running totals — no O(n) scan in snapshot()
  private totalCostUsd = 0;
  private totalTokens = 0;

  constructor(
    private readonly onUpdate: AgentToolUpdateCallback<RlmDetails>,
    private readonly sink?: TelemetrySink,
  ) {}

  /** Create a new sub-call entry. Returns the ID for subsequent updateSubcall calls. */
  addSubcall(init: SubcallInit): string {
    const id = `s${++this.seq}`;
    this.subcalls.set(id, {
      id,
      parentId: init.parentId,
      kind: init.kind,
      label: init.label,
      model: init.model,
      status: "running",
      detail: init.detail,
      args: init.args,
      startedAt: Date.now(),
      costUsd: 0,
      tokens: 0,
    });
    if (this.sink) {
      this.sink.start(id, {
        kind: init.kind, depth: init.depth ?? 0, parentId: init.parentId,
        model: init.model, label: init.label, detail: init.detail, args: init.args,
      });
    }
    this.emit();
    return id;
  }

  /**
   * Update an existing sub-call. All fields are partial — only supplied fields
   * are applied. costUsd and tokens are additive and also increment running totals.
   */
  updateSubcall(
    id: string,
    patch: Partial<Pick<RlmSubcall, "status" | "detail" | "args" | "resultPreview">> & {
      costUsd?: number;
      tokens?: number;
    },
  ): void {
    const sc = this.subcalls.get(id);
    if (!sc) return;
    if (patch.status !== undefined) {
      sc.status = patch.status;
      if (patch.status !== "running") sc.endedAt = Date.now();
    }
    if (patch.detail !== undefined) sc.detail = patch.detail;
    if (patch.args !== undefined) sc.args = patch.args;
    if (patch.resultPreview !== undefined) sc.resultPreview = patch.resultPreview;
    if (patch.costUsd !== undefined) {
      sc.costUsd += patch.costUsd;
      this.totalCostUsd += patch.costUsd;
    }
    if (patch.tokens !== undefined) {
      sc.tokens += patch.tokens;
      this.totalTokens += patch.tokens;
    }
    if (this.sink) {
      if (patch.costUsd !== undefined || patch.tokens !== undefined) {
        this.sink.usage(id, patch.costUsd ?? 0, patch.tokens ?? 0);
      }
      const isFinal = patch.status !== undefined && patch.status !== "running";
      if (isFinal) {
        this.sink.end(id, {
          error: patch.status === "error" ? (patch.detail ?? "error") : undefined,
          resultPreview: patch.resultPreview,
        });
      }
    }
    this.emit();
  }

  // ── Root-level methods (engine depth 0 only) ──

  setRootPrompt(text: string): void {
    this.rootPrompt = text;
  }

  setTurn(current: number, max: number): void {
    this.turnCurrent = current;
    this.turnMax = max;
    this.emit();
  }

  setAnswer(text: string): void {
    this.answer = text;
    this.emit();
  }

  setEdits(edits: ProposedEdit[]): void {
    this.edits = edits;
    this.emit(); // Bug fix: emit after setting edits
  }

  /** Accumulate usage directly to root-level totals (engine depth 0 turn costs). */
  addRootUsage(costUsd: number, tokens: number): void {
    this.totalCostUsd += costUsd;
    this.totalTokens += tokens;
    this.emit();
  }

  /** Finalize the root run status. Called once on engine completion/error/abort. */
  complete(status: RlmRunStatus): void {
    this.rootStatus = status;
    this.emit();
  }

  // ── Read ──

  /** Snapshot the current accumulated state for direct access (telemetry, tests). O(1). */
  snapshot(): RlmDetails {
    return {
      status: this.rootStatus,
      rootPrompt: this.rootPrompt,
      turns: { current: this.turnCurrent, max: this.turnMax },
      subcalls: [...this.subcalls.values()],
      totals: { costUsd: this.totalCostUsd, tokens: this.totalTokens },
      answer: this.answer,
      edits: this.edits,
    };
  }

  // ── Internal ──

  private emit(): void {
    this.onUpdate({
      content: [{ type: "text", text: this.answer ?? "(running...)" }],
      details: this.snapshot(),
    });
  }
}
