/**
 * Bench tasks — THE hardcore suite: `oolong` (oolongbench/oolong-synth).
 *
 * Kept from the rlm_test lab port (benches/oolong.py): aggregation questions over synthetic
 * records — multi-hop counting/classification where flat context-stuffing fails and only
 * retrieval + Python delegation wins. This is the suite every skill.state A/B campaign
 * (ab…ab6, r3–r5) was measured on; needle/s_niah/codeqa/browsecomp/codeqa_lb were pruned
 * (saturated at 100% or off-signal — they cannot detect a regression).
 *
 * Adaptation vs the lab: this project's sandbox exposes retrieval + delegation only (no
 * write/edit tools by design — Pi owns mutations), so every suite grades the ANSWER.
 */

import type { Grade } from "./grade.ts";
import { asStr, cachedTasks, hfRows } from "./data.ts";
import { scoreOolong } from "./scorers.ts";

export type SuiteName = "oolong";

export interface BenchTask {
  readonly id: string;
  readonly suite: SuiteName;
  readonly context: string;
  readonly prompt: string;
  readonly grade: Grade;
  readonly gold?: string;
}

interface OolongRecord {
  readonly id: string;
  readonly context: string;
  readonly question: string;
  readonly answer: unknown;
  readonly answerType: string;
  readonly taskGroup: string;
  readonly contextLen: number;
}

const OOLONG_MAX_CONTEXT_LEN = 65536; // hardcore: full dataset context_len range (last bucket = 65536 units)
const OOLONG_LIMIT = 24;
/** Rows here are ≤ ~160 KB at cl 65536 — bigger pages are safe and cut request count ~4×,
 *  well under the datasets-server rate limit. */
const OOLONG_PAGE_SIZE = 20;

export interface BenchBuildOpts {
  readonly oolongMaxCl?: number;
  readonly oolongLimit?: number;
}

/**
 * Extended runs (`--oolong-max-cl` / `--oolong-limit`): rows stream in ascending context_len,
 * so selection round-robins across context_len buckets — spread over lengths (and, via stream
 * order, task_groups) instead of only the smallest bucket. Deterministic per cache key.
 */
export async function buildTasks(
  suite: SuiteName,
  limit?: number,
  opts?: BenchBuildOpts,
): Promise<readonly BenchTask[]> {
  void suite; // single-member union — kept as a parameter so call sites stay stable
  const maxContextLen = opts?.oolongMaxCl ?? OOLONG_MAX_CONTEXT_LEN;
  const rows = opts?.oolongLimit ?? OOLONG_LIMIT;
  const cacheKey = `oolong_synth_cl${maxContextLen}_n${rows}`;
  const records = await cachedTasks<OolongRecord>(cacheKey, async () => {
    const candidates: OolongRecord[] = [];
    let seen = 0;
    for await (const row of hfRows("oolongbench/oolong", "test", OOLONG_PAGE_SIZE)) {
      const contextLen = typeof row.context_len === "number" ? row.context_len : Number(row.context_len ?? 0);
      if (!(contextLen <= maxContextLen)) continue;
      const context = asStr(row.context_window_text);
      if (!context) continue;
      candidates.push({
        id: asStr(row.id) || `oolong_${seen++}`,
        context,
        question: asStr(row.question),
        answer: row.answer,
        answerType: asStr(row.answer_type),
        taskGroup: asStr(row.task_group),
        contextLen,
      });
    }
    // Round-robin across context_len buckets — spread over lengths (and, via stream order,
    // task_groups) instead of only the smallest bucket. Deterministic per cache key.
    const buckets = new Map<number, OolongRecord[]>();
    for (const rec of candidates) {
      const bucket = buckets.get(rec.contextLen) ?? [];
      bucket.push(rec);
      buckets.set(rec.contextLen, bucket);
    }
    const lengths = [...buckets.keys()].sort((a, b) => a - b);
    const out: OolongRecord[] = [];
    while (out.length < rows && lengths.some((len) => (buckets.get(len)?.length ?? 0) > 0)) {
      for (const len of lengths) {
        const rec = buckets.get(len)?.shift();
        if (rec !== undefined) out.push(rec);
        if (out.length >= rows) break;
      }
    }
    return out;
  });
  return records.map((r): BenchTask => ({
    id: r.id,
    suite: "oolong",
    context: r.context,
    prompt:
      `${r.question}\n\n` +
      "Use the document in `context`. Prefer Python aggregation over guessing. " +
      "Put the final answer clearly in answer['content'].",
    grade: { kind: "score", gold: JSON.stringify(r.answer), scoreOf: (a) => scoreOolong(a, r.answer, r.answerType) },
    gold: JSON.stringify(r.answer),
  }));
}
