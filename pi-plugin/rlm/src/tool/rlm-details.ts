/**
 * RlmDetails — the structured payload for the RLM tool's AgentToolResult<T>.
 *
 * Replaces AgentTree + SubcallObserver. The RlmToolBridge accumulates sub-call
 * lifecycle events into a flat RlmSubcall[] array and calls onUpdate(partialResult)
 * after every mutation, enabling Pi's built-in progressive TUI re-render.
 */

export type SubcallKind = "root" | "rlm" | "llm" | "batch" | "tool";
export type SubcallStatus = "running" | "done" | "error";

/** Live activity of a node while status is "running" — powers the tree/modal UI. */
export type SubcallPhase = "thinking" | "texting" | "repl" | "waiting" | "spawning";
export type RlmRunStatus = "running" | "done" | "error" | "aborted";

export interface RlmSubcall {
  readonly id: string;
  /** Parent subcall ID for recursive grouping (undefined = direct child of root). */
  readonly parentId?: string;
  /** Recursion depth (0 = root tool call). */
  readonly depth: number;
  readonly kind: SubcallKind;
  readonly label: string;
  readonly model?: string;
  readonly status: SubcallStatus;
  /** Current activity while running (undefined = not reported). */
  readonly phase?: SubcallPhase;
  readonly detail?: string;
  readonly args?: string;
  readonly resultPreview?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly costUsd: number;
  readonly tokens: number;
  /** For batch subcalls: failed prompt count (partial failure). */
  readonly failedCount?: number;
  /** For batch subcalls: total prompt count. */
  readonly totalCount?: number;
}

export interface RlmDetails {
  readonly status: RlmRunStatus;
  /** Root node's live activity phase (root has no subcall entry). */
  readonly rootPhase?: SubcallPhase;
  readonly rootPrompt: string;
  readonly turns: { readonly current: number; readonly max: number };
  readonly subcalls: readonly RlmSubcall[];
  readonly totals: { readonly costUsd: number; readonly tokens: number };
  readonly answer?: string;
}

