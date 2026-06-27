/**
 * Resume fold — rebuilds engine state from a JSONL trail in one pass.
 *
 * The fold reuses the live engine's own prompt builders (`buildTurnPrompt`) so
 * the rebuilt history is faithful — DRY: the fold and the live loop share the
 * same message-construction helpers. Mid-file malformed rows fail; trailing
 * garbage from a crash is tolerated.
 */

import { readFile } from "node:fs/promises";
import { type ChatMsg } from "../bridge/model.ts";
import { appendUserMessage } from "../core/history.ts";
import { buildTurnPrompt } from "../prompts/user.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import { readHeader } from "./reads.ts";
import {
  isCompaction,
  isHeader,
  isPhase,
  isRow,
  isTerminal,
  isTodo,
  isTurn,
  STATE_SCHEMA_VERSION,
  type Row,
  type RunHeader,
} from "./rows.ts";
import { trailPath, snapshotPath } from "./paths.ts";
import { failSoft, pathExists } from "./internal.ts";

export interface PhaseRecon {
  readonly current: string;
  readonly advancedAt: number;
  readonly summary?: string;
}

export type ReconstructResult =
  | {
      readonly ok: true;
      readonly header: RunHeader;
      readonly history: ChatMsg[];
      readonly pendingReplOutputs?: string;
      readonly usageSeed: { readonly costUsd: number; readonly inputTokens: number; readonly outputTokens: number; readonly durationMs: number };
      readonly best: string;
      readonly editsAcc: ProposedEdit[];
      readonly completedTurns: number;
      readonly compactions: number;
      /** R-C1: the latest turn whose per-turn snapshot file exists on disk (undefined ⇒ no restore). */
      readonly snapshotTurn: number | undefined;
      readonly todoRows: readonly { readonly action: string; readonly params: Record<string, unknown>; readonly result: string }[];
      readonly terminated: boolean;
      /** Reconstructed pipeline phase state. undefined ⇒ pre-v3 trail (treats as research). */
      readonly phase?: PhaseRecon;
    }
  | { readonly ok: false; readonly reason: "no-header" | "version-mismatch" | "no-turns" | "mid-file-hole"; readonly detail: string };

/** QB: single read + parse — detects mid-file holes without reading the trail twice. */
async function readRowsStrict(cwd: string, dir: string, runId: string): Promise<{ readonly rows: Row[]; readonly hole: boolean }> {
  const path = trailPath(cwd, dir, runId);
  if (!await pathExists(path)) return { rows: [], hole: false };
  const content = await failSoft(() => readFile(path, "utf-8"), undefined as string | undefined);
  const trimmed = content?.trim();
  if (!trimmed) return { rows: [], hole: false };

  const rows: Row[] = [];
  let sawBad = false;
  for (const line of trimmed.split("\n")) {
    try {
      const row = JSON.parse(line) as unknown;
      if (!isRow(row)) {
        sawBad = true;
        continue;
      }
      rows.push(row);
      if (sawBad) return { rows, hole: true }; // good line after a bad one = mid-file hole
    } catch {
      sawBad = true; // trailing bad line tolerated; a subsequent good line means a hole
    }
  }
  return { rows, hole: false };
}

export async function reconstructRlmState(
  cwd: string,
  dir: string,
  runId: string,
  systemPrompt: string,
): Promise<ReconstructResult> {
  const header = await readHeader(cwd, dir, runId);
  if (!header) return { ok: false, reason: "no-header", detail: runId };
  // QB: ??1 backward-compat — when bumping STATE_SCHEMA_VERSION, also bump this default
  // so trails written without an explicit `v` field are rejected rather than silently passed.
  if ((header.v ?? 1) !== STATE_SCHEMA_VERSION)
    return { ok: false, reason: "version-mismatch", detail: `run ${runId} written under schema v${header.v}` };

  const { rows, hole } = await readRowsStrict(cwd, dir, runId);
  if (hole) return { ok: false, reason: "mid-file-hole", detail: runId };

  let history: ChatMsg[] = [{ role: "system", content: systemPrompt }];
  const usageSeed = { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  let best = "";
  let editsAcc: ProposedEdit[] = [];
  let completedTurns = 0;
  let compactions = 0;
  let snapshotTurn: number | undefined; // R-C1: latest turn with an existing snapshot file
  let pendingReplOutputs: string | undefined;
  const todoRows: { action: string; params: Record<string, unknown>; result: string }[] = [];
  let terminated = false;
  let phase: PhaseRecon | undefined;

  for (const row of rows) {
    if (isHeader(row)) continue;
    if (isCompaction(row)) {
      history = [...row.history];
      compactions++;
      usageSeed.costUsd += row.usage.costUsd;
      usageSeed.inputTokens += row.usage.inputTokens;
      usageSeed.outputTokens += row.usage.outputTokens;
      pendingReplOutputs = undefined;
      continue;
    }
    if (isTurn(row)) {
      const i = row.turn - 1;
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      appendUserMessage(history, buildTurnPrompt(i, header.meta.maxIterations));
      history.push({ role: "assistant", content: row.response });
      usageSeed.costUsd += row.usage.costUsd;
      usageSeed.inputTokens += row.usage.inputTokens;
      usageSeed.outputTokens += row.usage.outputTokens;
      if (row.answerContent) best = row.answerContent;
      else if (!best && row.response.trim()) best = row.response; // C3: mirror engine fallback
      if (row.edits && row.edits.length > 0) editsAcc = [...row.edits];
      completedTurns = row.turn;
      // R-C1: verify the per-turn snapshot file exists — a crashed finalize leaves the row claiming snapshotOk:true with no pkl.
      if (row.snapshotOk && await pathExists(snapshotPath(cwd, dir, runId, row.turn)))
        snapshotTurn = row.turn;
      usageSeed.durationMs = row.cumulativeDurationMs; // C2: seed wall-clock
      pendingReplOutputs = row.replOutputs;
      continue;
    }
    if (isPhase(row)) {
      phase = { current: row.phase, advancedAt: row.turn - 1, summary: row.summary };
      continue;
    }
    if (isTodo(row)) {
      todoRows.push({ action: row.action, params: row.params, result: row.result });
      continue;
    }
    if (isTerminal(row)) terminated = true;
  }

  if (completedTurns === 0 && !terminated) return { ok: false, reason: "no-turns", detail: runId };
  return { ok: true, header, history, pendingReplOutputs, usageSeed, best, editsAcc, completedTurns, compactions, snapshotTurn, todoRows, terminated, phase };
}
