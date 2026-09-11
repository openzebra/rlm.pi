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
  /** 1-based repeat index within one invocation (--runs N); absent in pre-r3 journals. */
  readonly run?: number;
  /** P2 §3.4: the graded answer came from the run's last repl stdout, not from a final
   *  `answer[…]` frame. Absent = the normal path. Report counts these separately. */
  readonly recovered?: boolean;
  /** Which surface the graded answer came from: "final" frame or recovered "stdout". */
  readonly answerSource?: "final" | "stdout";
}

const ANSWER_TRUNCATE = 500;

export function makeRow(base: Omit<BenchRow, "answer"> & { answer: string }): BenchRow {
  const { gold, error, recovered, answerSource, ...rest } = base;
  return {
    ...rest,
    answer: base.answer.slice(0, ANSWER_TRUNCATE),
    ...(gold !== undefined ? { gold } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(recovered !== undefined ? { recovered } : {}),
    ...(answerSource !== undefined ? { answerSource } : {}),
  };
}

export function appendRow(journalPath: string, row: BenchRow): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify(row)}\n`);
}


