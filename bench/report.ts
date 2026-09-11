/**
 * bench/report.ts — aggregate reader for bench journals (JSONL). Pure reader: no engine, no
 * network. Prints a (suite, model) summary table, a per-task ✓/✗ matrix across the given
 * journals, and — for oolong-family suites, joined from the bench/data caches — the
 * taskGroup/answerType of each task plus the "ceiling cluster" (tasks no run ever passed).
 *
 * Usage (from the repo root):
 *   bun run bench/report.ts bench/runs/r3-oolong-qwen38-27b.jsonl
 *   bun run bench/report.ts bench/runs/a.jsonl bench/runs/b.jsonl --by-run
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BenchRow } from "./journal.ts";

// ------------------------------------------------------------------ args ----

interface ReportArgs {
  readonly files: readonly string[];
  readonly byRun: boolean;
}

function parseArgs(argv: readonly string[]): ReportArgs {
  const files: string[] = [];
  let byRun = false;
  for (const a of argv) {
    if (a === "--by-run") byRun = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else files.push(a);
  }
  if (files.length === 0) {
    throw new Error("usage: bun run bench/report.ts <journal.jsonl> [more.jsonl …] [--by-run]");
  }
  return Object.freeze({ files: Object.freeze(files), byRun });
}

// ---------------------------------------------------------------- parsing ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isBenchRow(v: unknown): v is BenchRow {
  return (
    isRecord(v) &&
    typeof v.suite === "string" &&
    typeof v.taskId === "string" &&
    typeof v.model === "string" &&
    typeof v.correct === "boolean" &&
    typeof v.recall === "number" &&
    typeof v.answer === "string" &&
    typeof v.latencyMs === "number" &&
    typeof v.inputTokens === "number" &&
    typeof v.outputTokens === "number" &&
    typeof v.iterations === "number" &&
    typeof v.costUsd === "number"
  );
}

interface Journal {
  readonly name: string;
  readonly rows: readonly BenchRow[];
  readonly skipped: number;
}

/** Fail-soft: an unparseable line is skipped and counted, never fatal. A missing journal
 *  file, however, is operator error — fail fast with an actionable message. */
function loadJournal(name: string): Journal {
  const rows: BenchRow[] = [];
  let skipped = 0;
  let text: string;
  try {
    text = readFileSync(name, "utf8");
  } catch (err) {
    throw new Error(`cannot read journal ${name}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isBenchRow(parsed)) rows.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { name, rows, skipped };
}

// ------------------------------------------------- oolong cache metadata ----

interface OolongMeta {
  readonly taskGroup: string;
  readonly answerType: string;
}

const DATA_DIR = fileURLToPath(new URL("./data/", import.meta.url));

/** id → {taskGroup, answerType} from the oolong task caches under bench/data/. The glob covers
 *  the bare (`oolong_synth_*`) AND coached (`oolong_coached_synth_*`) caches — same task ids,
 *  so merging is safe. Fail-soft: missing/corrupt caches just mean `n/a` metadata. */
function loadOolongMeta(): ReadonlyMap<string, OolongMeta> {
  const meta = new Map<string, OolongMeta>();
  let names: readonly string[];
  try {
    names = readdirSync(DATA_DIR).filter((f) => /^oolong.*_synth_.*\.json$/.test(f));
  } catch {
    return meta;
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${DATA_DIR}${name}`, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const rec of parsed) {
        if (!isRecord(rec) || typeof rec.id !== "string") continue;
        meta.set(
          rec.id,
          Object.freeze({
            taskGroup: typeof rec.taskGroup === "string" ? rec.taskGroup : "n/a",
            answerType: typeof rec.answerType === "string" ? rec.answerType : "n/a",
          }),
        );
      }
    } catch {
      // fail-soft: a corrupt cache file just means n/a metadata
    }
  }
  return meta;
}

// ----------------------------------------------------------------- tables ----

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function printTable(header: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  console.log(header.map((h, i) => pad(h, widths[i] ?? 0)).join("  "));
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i] ?? 0)).join("  "));
}

function pctStr(correct: number, n: number): string {
  return n > 0 ? `${((correct / n) * 100).toFixed(1)}%` : "n/a";
}

/** P4.1 (plan §3.5 A.4): a ✗ is only informative when the model actually ANSWERED. An empty
 *  answer, an engine stub (`(no final answer…)`, `(stopped: …)`, `(aborted)`) or a crashed row
 *  is a DEGENERATE failure — the run never produced a comparable value. Rendering those as a
 *  plain ✗ silently mixes "wrong answer" with "no answer", which is how a run with 0% shows
 *  up looking like a hard task rather than a broken harness. They get `!` and a legend. */
const ENGINE_STUB_RE = /^\((?:no final answer|stopped|aborted|no answer)/;

function isDegenerate(r: BenchRow): boolean {
  if (typeof r.error === "string" && r.error.length > 0) return true;
  const a = r.answer.trim();
  return a.length === 0 || ENGINE_STUB_RE.test(a);
}

function avgStr(sum: number, n: number, digits = 2): string {
  return n > 0 ? (sum / n).toFixed(digits) : "n/a";
}

function printSummary(journals: readonly Journal[], byRun: boolean): void {
  const groups = new Map<string, BenchRow[]>();
  const order: string[] = [];
  for (const j of journals) {
    for (const r of j.rows) {
      const key =
        byRun && r.run !== undefined ? `${r.suite}|${r.model}|run=${r.run}` : `${r.suite}|${r.model}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = [];
        groups.set(key, g);
        order.push(key);
      }
      g.push(r);
    }
  }
  console.log("\n== summary by (suite, model) ==");
  if (order.length === 0) {
    console.log("no rows — nothing to summarize");
    return;
  }
  const header = ["suite/model", "n", "correct", "pct", "recov", "invalid", "recall", "iters", "lat_s", "in_tok", "out_tok", "cost_usd", "$/correct"];
  const invalidGroups: string[] = [];
  const rows = order.map((k) => {
    const rs = groups.get(k) ?? [];
    const n = rs.length;
    let correct = 0;
    let recall = 0;
    let iterations = 0;
    let latencyMs = 0;
    let inTok = 0;
    let outTok = 0;
    let costUsd = 0;
    let recovered = 0;
    let invalid = 0;
    for (const r of rs) {
      if (r.correct) correct += 1;
      if (r.recovered === true) recovered += 1;
      if (isDegenerate(r)) invalid += 1;
      recall += r.recall;
      iterations += r.iterations;
      latencyMs += r.latencyMs;
      inTok += r.inputTokens;
      outTok += r.outputTokens;
      costUsd += r.costUsd;
    }
    // P4.1 (plan §3.5 A.4): `correct == 0` AND every row degenerate → INVALID. Such a group is
    // not a measurement at all (the harness never produced an answer), so it is excluded from
    // the pooled TOTAL line instead of dragging the average toward 0.
    const invalidRow = correct === 0 && n > 0 && invalid === n;
    if (invalidRow) invalidGroups.push(k);
    return [
      k.split("|").join("  "),
      String(n),
      String(correct),
      invalidRow ? "INVALID" : pctStr(correct, n),
      String(recovered),
      String(invalid),
      avgStr(recall, n),
      avgStr(iterations, n),
      avgStr(latencyMs / 1000, n, 1),
      String(inTok),
      String(outTok),
      costUsd.toFixed(4),
      // P3.3: dollars spent per CORRECT answer (the number the paper's cost table needs).
      // n/a when nothing passed — dividing by zero would read as "free".
      correct > 0 ? (costUsd / correct).toFixed(4) : "n/a",
    ] as const;
  });
  // Pooled TOTAL over the VALID groups only (P4.1) — printed as one extra row after the table.
  {
    const invalidSet = new Set(invalidGroups);
    let tvN = 0;
    let tvCorrect = 0;
    for (const [i, k] of order.entries()) {
      if (invalidSet.has(k)) continue;
      const r = rows[i];
      if (r === undefined) continue;
      tvN += Number(r[1]);
      tvCorrect += Number(r[2]);
    }
    if (invalidGroups.length > 0 && tvN > 0) {
      printTable(
        ["TOTAL (valid only)", "n", "correct", "pct"],
        [["", String(tvN), String(tvCorrect), pctStr(tvCorrect, tvN)] as const],
      );
    }
  }
  printTable(header, rows);
  const notes: string[] = [];
  if (invalidGroups.length > 0) {
    notes.push(
      `INVALID group(s) (every row degenerate → not a measurement, excluded from TOTAL): ${invalidGroups.join(", ")}`,
    );
  }
  const totalRecov = rows.reduce((s, r) => s + Number(r[4]), 0);
  const totalInvalid = rows.reduce((s, r) => s + Number(r[5]), 0);
  if (totalRecov > 0) notes.push(`${totalRecov} row(s) recovered from last repl stdout (P2 §3.4)`);
  if (totalInvalid > 0) {
    notes.push(
      `${totalInvalid} degenerate row(s) (empty/stub answer or error) — those are harness failures, not wrong answers`,
    );
  }
  for (const nt of notes) console.log(`  note: ${nt}`);
}

interface TaskTotal {
  readonly passes: number;
  readonly runs: number;
}

/** Per-task matrix: taskId rows × journal columns. A journal holding several runs of the same
 *  task (e.g. `--runs 3`) renders the cell as `p/n`; single rows render ✓/✗. Returns the
 *  pooled per-task totals for the ceiling-cluster section. */
function printMatrix(
  journals: readonly Journal[],
  meta: ReadonlyMap<string, OolongMeta>,
): ReadonlyMap<string, TaskTotal> {
  console.log("\n== per-task matrix ==");
  const taskIds: string[] = [];
  const seen = new Set<string>();
  const perJournal = new Map<string, { passes: number; runs: number }>();
  const totals = new Map<string, { passes: number; runs: number }>();
  for (const [ji, j] of journals.entries()) {
    for (const r of j.rows) {
      if (!seen.has(r.taskId)) {
        seen.add(r.taskId);
        taskIds.push(r.taskId);
      }
      const cell = perJournal.get(`${ji}:${r.taskId}`) ?? { passes: 0, runs: 0 };
      cell.runs += 1;
      if (r.correct) cell.passes += 1;
      perJournal.set(`${ji}:${r.taskId}`, cell);
      const tot = totals.get(r.taskId) ?? { passes: 0, runs: 0 };
      tot.runs += 1;
      if (r.correct) tot.passes += 1;
      totals.set(r.taskId, tot);
    }
  }
  if (taskIds.length === 0) {
    console.log("no rows");
    return new Map();
  }
  const header = ["task", "group/type", ...journals.map((j) => j.name.split("/").pop() ?? j.name), "passes"];
  // Degenerate cells are tracked per journal+task so the matrix can render `!` (P4.1).
  const degenerate = new Set<string>();
  for (const [ji, j] of journals.entries()) {
    for (const r of j.rows) {
      if (isDegenerate(r)) degenerate.add(`${ji}:${r.taskId}`);
    }
  }
  const rows = taskIds.map((id) => {
    const m = meta.get(id);
    const cells = journals.map((_, ji) => {
      const c = perJournal.get(`${ji}:${id}`);
      if (c === undefined) return "-";
      if (c.passes === 0 && degenerate.has(`${ji}:${id}`)) return "!";
      return c.runs > 1 ? `${c.passes}/${c.runs}` : c.passes > 0 ? "✓" : "✗";
    });
    const t = totals.get(id);
    return [
      id,
      m !== undefined ? `${m.taskGroup}/${m.answerType}` : "n/a",
      ...cells,
      t !== undefined ? `${t.passes}/${t.runs}` : "-",
    ] as const;
  });
  printTable(header, rows);
  console.log("legend: ✓ pass   ✗ wrong answer   ! degenerate (empty/stub answer or error)");
  const out = new Map<string, TaskTotal>();
  for (const [id, t] of totals) out.set(id, Object.freeze({ ...t }));
  return out;
}

function printCeiling(totals: ReadonlyMap<string, TaskTotal>, meta: ReadonlyMap<string, OolongMeta>): void {
  const ceiling = [...totals.entries()].filter(([, t]) => t.passes === 0);
  console.log("\n== ceiling cluster ==");
  if (ceiling.length === 0) {
    console.log("none — every task passed at least once");
    return;
  }
  console.log(`${ceiling.length} task(s) never passed (0/N across all journals):`);
  for (const [id, t] of ceiling) {
    const m = meta.get(id);
    console.log(`  ${id}  0/${t.runs}  ${m !== undefined ? `${m.taskGroup}/${m.answerType}` : "n/a"}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const journals = args.files.map(loadJournal);
  for (const j of journals) {
    const skippedNote = j.skipped > 0 ? ` (${j.skipped} unparseable line(s) skipped)` : "";
    console.log(`[report] ${j.name}: ${j.rows.length} rows${skippedNote}`);
  }
  const meta = loadOolongMeta();
  printSummary(journals, args.byRun);
  const totals = printMatrix(journals, meta);
  printCeiling(totals, meta);
}

try {
  main();
} catch (err) {
  console.error(`report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
