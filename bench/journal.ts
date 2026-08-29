/**
 * Run journal (JSONL) — ported from the rlm_test lab's suite.py `_row`/`_append`.
 * Row fields mirror the lab's e2e journal where they apply. Journal only — no aggregate
 * report is written.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface BenchRow {
  readonly suite: string;
  readonly taskId: string;
  readonly model: string;
  readonly correct: boolean;
  readonly recall: number;
  readonly answer: string;
  readonly gold?: string;
  readonly error?: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly iterations: number;
  readonly costUsd: number;
}

const ANSWER_TRUNCATE = 500;

export function makeRow(base: Omit<BenchRow, "answer"> & { answer: string }): BenchRow {
  const { gold, error, ...rest } = base;
  return {
    ...rest,
    answer: base.answer.slice(0, ANSWER_TRUNCATE),
    ...(gold !== undefined ? { gold } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function appendRow(journalPath: string, row: BenchRow): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify(row)}\n`);
}


