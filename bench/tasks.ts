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
import { asStr, cachedTaskSlice, cachedTasks, hfRows } from "./data.ts";
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
/** P1 (附D.3) — 先探测 → 再聚合 → 显式提交. VERBATIM from the plan (附D.3 code block).
 *  One constant, appended at BOTH prompt sites: the cached-slice fast path AND the HF-fetch
 *  path. Changing only one is "本仓库最阴的雷" (cache hit behaves differently than fetch).
 *  Review rule (附D.3): no task-label / gold string may appear here — that is answer leakage. */
const OOLONG_PROMPT_TAIL =
  "\n\n Work inside `context` (a list of lines) with Python:\n" +
  "1) PROBE FIRST: print(len(context)), context[0], and how many lines contain '||'.\n" +
  "2) AGGREGATE IN CODE: use collections.Counter over ALL lines; never estimate a count by eye.\n" +
  "3) VERIFY: state the winner and the margin (e.g. 875 vs 499); if the margin is under 5%, recount a second way.\n" +
  "4) SUBMIT: answer['content'] = '<the final value>' — a single bare value, no prose, no explanation.\n" +
  "Use llm_query only for bounded judgement over small slices (<=200 lines).";

/** Cheap structural proof that the labeled arm really carries leaf labels: a silent fallback
 *  to the plain column would make the A/B meaningless without anyone noticing (plan P0). The
 *  plan's acceptance counts the `|| Label:` marker specifically (not a bare "Label: "). */
function assertLabeledContexts(records: readonly OolongRecord[]): void {
  const labeled = records.filter((r) => r.context.includes("|| Label: ")).length;
  console.log(
    `[tasks] labeled arm: ${labeled}/${records.length} contexts carry '|| Label: '` +
      ` (ctx[0]=${records[0]?.context.length ?? 0} chars)`,
  );
  if (labeled === 0) {
    throw new Error(
      "oolongLabels requested but no context contains '|| Label: ' — is the dataset column missing?",
    );
  }
}

export interface BenchBuildOpts {
  readonly oolongMaxCl?: number;
  readonly oolongLimit?: number;
  /** Labeled prompt arm: cache + read `oolong_synth_lab_*` pages (leaf labels in context). */
  readonly oolongLabels?: boolean;
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
  const wantLabels = opts?.oolongLabels === true;
  // Fast path: an equal-or-larger cache for this (cl, n) shape exists on disk — slice it
  // and never touch HuggingFace (dataset is already local; smoke runs must not re-fetch).
  const sliced = cachedTaskSlice<OolongRecord>(rows, maxContextLen, { labels: wantLabels });
  if (sliced !== undefined) {
    if (wantLabels) assertLabeledContexts(sliced);
    return sliced.map((r): BenchTask => ({
      id: r.id,
      suite: "oolong" as const,
      context: r.context,
      // P1 (附D.3): the plan's literal edit — keep the two existing lines, append the recipe tail.
      // Identical wording at BOTH sites (this fast path + the HF-fetch path below).
      prompt:
        `${r.question}\n\n` +
        "Use the document in `context`. Prefer Python aggregation over guessing. " +
        "Put the final answer clearly in answer['content']." + OOLONG_PROMPT_TAIL,
      grade: { kind: "score", gold: JSON.stringify(r.answer), scoreOf: (a) => scoreOolong(a, r.answer, r.answerType) },
      gold: JSON.stringify(r.answer),
    }));
  }
  // P0 附D.1 (verbatim): 新 key — 老缓存绝不会命中。The plan writes two spellings; this is the
  // one from §P0's snippet and the acceptance script, and bench/data.ts's regex accepts both,
  // so a cache warmed under either name is still recognised. The unlabeled arm keeps its own
  // (older) key — that asymmetry IS the fix.
  const cacheKey = wantLabels
    ? `oolong_synth_lab_cl${maxContextLen}_n${rows}`
    : `oolong_synth_cl${maxContextLen}_n${rows}`;
  const records = await cachedTasks<OolongRecord>(cacheKey, async () => {
    const candidates: OolongRecord[] = [];
    let seen = 0;
    // NOTE: `oolongbench/oolong` is gated/unreachable without auth — /rows serves
    // only `oolongbench/oolong-synth` (the synth pool these caches are named after).
    for await (const row of hfRows("oolongbench/oolong-synth", "test", OOLONG_PAGE_SIZE)) {
      const contextLen = typeof row.context_len === "number" ? row.context_len : Number(row.context_len ?? 0);
      if (!(contextLen <= maxContextLen)) continue;
      // P0 (计划 §3 P0，逐字)：wantLabels → `context_window_text_with_labels`，缺失时回退
      // 无标注列（`||` 与计划片段一致）——池子因此与原池同形（同 id 序、同 gold）。
      // assertLabeledContexts 下面会报“真带标签的行数”，系统性缺失仍然会响亮失败。
      const context = wantLabels
        ? asStr(row.context_window_text_with_labels) || asStr(row.context_window_text)
        : asStr(row.context_window_text);
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
  if (wantLabels) assertLabeledContexts(records);
  return records.map((r): BenchTask => ({
    id: r.id,
    suite: "oolong",
    context: r.context,
    // P1 (附D.3): same appending as the cached-slice path above — one constant, two sites.
    prompt:
      `${r.question}\n\n` +
      "Use the document in `context`. Prefer Python aggregation over guessing. " +
      "Put the final answer clearly in answer['content']." + OOLONG_PROMPT_TAIL,
    grade: { kind: "score", gold: JSON.stringify(r.answer), scoreOf: (a) => scoreOolong(a, r.answer, r.answerType) },
    gold: JSON.stringify(r.answer),
  }));
}
