/**
 * RlmDetails — the structured payload for the RLM tool's AgentToolResult<T>.
 *
 * Replaces AgentTree + SubcallObserver. The RlmToolBridge accumulates sub-call
 * lifecycle events into a flat RlmSubcall[] array and calls onUpdate(partialResult)
 * after every mutation, enabling Pi's built-in progressive TUI re-render.
 */

import type { ProposedEdit } from "../sandbox/protocol.ts";

export type SubcallKind = "root" | "rlm" | "llm" | "batch" | "tool";
export type SubcallStatus = "running" | "done" | "error";
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
  readonly detail?: string;
  readonly args?: string;
  readonly resultPreview?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly costUsd: number;
  readonly tokens: number;
}

export interface RlmDetails {
  readonly status: RlmRunStatus;
  readonly rootPrompt: string;
  readonly turns: { readonly current: number; readonly max: number };
  readonly subcalls: readonly RlmSubcall[];
  readonly totals: { readonly costUsd: number; readonly tokens: number };
  readonly answer?: string;
  readonly edits?: readonly ProposedEdit[];
}

export interface SubcallInit {
  readonly parentId?: string;
  readonly kind: SubcallKind;
  readonly label: string;
  readonly model?: string;
  readonly detail?: string;
  readonly args?: string;
  /** Recursion depth. Required — all call sites pass this. */
  readonly depth: number;
}
