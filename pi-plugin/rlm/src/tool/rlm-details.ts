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
  id: string;
  /** Parent subcall ID for recursive grouping (undefined = direct child of root). */
  parentId?: string;
  /** Recursion depth (0 = root tool call). */
  depth: number;
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
  /** Recursion depth. Required — all call sites pass this. */
  depth: number;
}

