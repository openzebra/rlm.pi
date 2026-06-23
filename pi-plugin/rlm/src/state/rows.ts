/**
 * Run-state row shapes for the RLM JSONL audit trail.
 *
 * REPLAY CONTRACT: every field below is part of the resume fold's reconstruction.
 * If any field is added, removed, or its semantics change, bump STATE_SCHEMA_VERSION
 * so older trails are rejected rather than mis-replayed.
 *
 * Guards accept `unknown` and narrow via `hasKind` — no `any`, no `!`.
 */

import type { ChatMsg } from "../bridge/model.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";

/** Bump when a row shape changes such that the resume fold cannot replay older files. */
export const STATE_SCHEMA_VERSION = 1;

export interface UsageRow {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Line 1 of every trail. Carries everything the fold needs to rebuild the system prompt + reload context. */
export interface RunHeader {
  readonly kind: "header";
  readonly v: number;
  readonly runId: string;
  readonly ts: string;
  readonly rootPrompt: string;
  readonly context: { readonly type: string; readonly chars: number; readonly json: boolean; readonly projectMap: boolean };
  readonly workspaceRoot?: string;
  readonly models: { readonly smart: string; readonly worker: string };
  /** Snapshot of the replay-affecting config (maxIterations, orchestrator, editEnabled, fsTools…). */
  readonly meta: {
    readonly maxIterations: number;
    readonly maxDepth: number;
    readonly orchestrator: boolean;
    readonly editEnabled: boolean;
    readonly fsTools: boolean;
  };
}

/** One completed turn. `response`+`replOutputs` rebuild history; the rest restore scalars. */
export interface TurnRow {
  readonly kind: "turn";
  readonly turn: number;            // 1-based (== engine `i + 1`)
  readonly ts: string;
  readonly response: string;        // assistant message
  readonly replOutputs?: string;    // formatReplOutputs(results) → next user message
  readonly answerContent?: string;  // restores `best`
  readonly edits?: readonly ProposedEdit[]; // restores editsAcc (latest wins)
  readonly error: boolean;          // turnHadError → limits.observe on resume
  readonly usage: UsageRow;
  readonly cumulativeDurationMs: number; // limits.usage().durationMs at turn-write time
  readonly snapshotOk: boolean;     // whether sandbox.pkl reflects THIS turn
}

/** Emitted when compaction rewrites history; the fold replaces history wholesale. */
export interface CompactionRow {
  readonly kind: "compaction";
  readonly turn: number;
  readonly ts: string;
  readonly history: readonly ChatMsg[]; // post-compaction array (small by design)
  readonly usage: UsageRow;             // compaction model cost added to limits
}

export interface TerminalRow {
  readonly kind: "terminal";
  readonly ts: string;
  readonly status: "completed" | "finalized" | "aborted" | "stopped";
  readonly answer: string;
  readonly iterations: number;
  readonly usage: UsageRow;
}

export type Row = RunHeader | TurnRow | CompactionRow | TerminalRow;

const hasKind = (r: unknown, k: Row["kind"]): boolean =>
  typeof r === "object" && r !== null && (r as { kind?: unknown }).kind === k;

export const isHeader = (r: unknown): r is RunHeader =>
  hasKind(r, "header") && typeof (r as RunHeader).runId === "string" && typeof (r as RunHeader).rootPrompt === "string";

export const isTurn = (r: unknown): r is TurnRow =>
  hasKind(r, "turn") && typeof (r as TurnRow).turn === "number" && typeof (r as TurnRow).response === "string";

export const isCompaction = (r: unknown): r is CompactionRow =>
  hasKind(r, "compaction") && Array.isArray((r as CompactionRow).history);

export const isTerminal = (r: unknown): r is TerminalRow => hasKind(r, "terminal");
