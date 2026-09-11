/**
 * bench/run.ts — e2e benchmark driver for THIS project's RLM engine.
 *
 * Drives pi-plugin/rlm's headless engine (`createEngine`) against real OpenRouter models with
 * THE hardcore suite: oolong (oolongbench/oolong-synth) — the only benchmark that can
 *
 * r3 runs a SINGLE model (bench/engine.ts DEFAULT_MODEL_REF = qwen3.8-27b, real OpenRouter
 * pricing fetched at runtime); temperature defaults to 0; repeats (`--runs N`) must be
 * reported pooled, never single-run — aggregate with bench/report.ts.
 *
 * Env vars (the only key transport — never hardcode keys, never commit them):
 *   OPENROUTER_API_KEY / ZAI_API_KEY  required (matches the --model provider)
 *   RLM_BENCH_MODEL           optional, default DEFAULT_MODEL_REF (openrouter/qwen/qwen3.8-27b)
 *   RLM_BENCH_CONTEXT_WINDOW  optional, default 1000000
 *
 * Usage (from the repo root):
 *   bun run bench/run.ts                      # oolong, default 8 tasks @ cl ≤ 2048
 *   bun run bench/run.ts --limit 1            # first task only
 *   bun run bench/run.ts --oolong-max-cl 65536 --oolong-limit 24
 *                                             # extended oolong: context_len cap / task count
 *   bun run bench/run.ts --model openrouter/google/gemma-4-31b-it:free
 *   bun run bench/run.ts --sub-model zai/glm-4.7   # llm tier (thinking off by dialect)
 *   bun run bench/run.ts --list               # print tasks + context sizes, no engine
 *   bun run bench/run.ts --oolong-labels      # labeled arm: leaf-label context (P0),
 *                                             # separate cache family oolong_lab_synth_*
 *   bun run bench/run.ts --pool-only          # materialize + verify the pool, zero model calls
 *   bun run bench/run.ts --task-ids 550,551   # only oolong_550/oolong_551 (deep-water family)
 *   bun run bench/run.ts --journal bench/runs/foo.jsonl --resume
 *                                             # crash-safe pooled run: rows already in the
 *                                             # journal (same model+task+run) are skipped
 *   bun run bench/run.ts --runs 3 --max-iterations 16 \
 *     --model openrouter/qwen/qwen3.8-27b   # NO --reasoning flag: RLM root never thinks
 *                                             # r3-style: repeats + thinking arm
 *
 * Artifacts: JSONL journal bench/runs/bench-<ts>.jsonl — aggregate via bench/report.ts.
 * A sidecar `<journal>.config.json` (P4.2) records model/temp/runs/labels/skillstate/git rev
 * so a journal stays readable without the shell that produced it.
 */

import { appendRow, makeRow, type BenchRow } from "./journal.ts";
import { gradeAnswer } from "./grade.ts";
import { DEFAULT_MODEL_REF, fetchPricing, makeRun, requireApiKey, resolveTarget, type BenchPricing, type BenchRunOpts } from "./engine.ts";
import { buildTasks, type BenchTask, type SuiteName } from "./tasks.ts";
import { SkillStore } from "../pi-plugin/rlm/src/config/skillstate.ts";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunRlm } from "../pi-plugin/rlm/src/core/types.ts";

interface Args {
  readonly suite: SuiteName;
  readonly limit?: number;
  readonly model?: string;
  readonly subModel?: string;
  readonly journal?: string;
  readonly oolongMaxCl?: number;
  readonly oolongLimit?: number;
  /** Labeled prompt arm (plan P0.1): context = leaf-label rendering, separate cache family. */
  readonly oolongLabels?: boolean;
  readonly runs?: number;
  readonly maxIterations?: number;
  readonly temperature?: number;
  readonly list: boolean;
  /** Materialize the task pool (caches included) and exit before any model call (plan P0.5). */
  readonly poolOnly: boolean;
  /** P4.3: run only these task suffixes (`--task-ids 550,551,552` → `oolong_550` …). The deep-
   *  water family is a token black hole (plan §1.2), so it gets its own suite run. */
  readonly taskIds?: readonly string[];
  readonly resume: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let suite: SuiteName = "oolong";
  let limit: number | undefined;
  let model: string | undefined;
  let subModel: string | undefined;
  let journal: string | undefined;
  let oolongMaxCl: number | undefined;
  let oolongLimit: number | undefined;
  let oolongLabels: boolean | undefined;
  let runs: number | undefined;
  let maxIterations: number | undefined;
  let temperature: number | undefined;
  let list = false;
  let poolOnly = false;
  let taskIds: readonly string[] | undefined;
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      i++;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--limit") {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 1) throw new Error(`--limit must be a positive integer`);
      limit = v;
    } else if (a === "--oolong-max-cl") {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 1) throw new Error(`--oolong-max-cl must be a positive integer`);
      oolongMaxCl = v;
    } else if (a === "--oolong-limit") {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 1) throw new Error(`--oolong-limit must be a positive integer`);
      oolongLimit = v;
    } else if (a === "--oolong-labels") {
      oolongLabels = true;
    } else if (a === "--pool-only") {
      poolOnly = true;
    } else if (a === "--task-ids") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--task-ids needs a comma-separated list (e.g. 550,551)");
      taskIds = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === "--runs") {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 1) throw new Error(`--runs must be a positive integer`);
      runs = v;
    } else if (a === "--max-iterations") {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 1) throw new Error(`--max-iterations must be a positive integer`);
      maxIterations = v;
    } else if (a === "--temperature") {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0 || v > 2) throw new Error(`--temperature must be a number in [0, 2]`);
      temperature = v;
    } else if (a === "--model") {
      model = next();
    } else if (a === "--sub-model") {
      subModel = next();
    } else if (a === "--journal") {
      journal = next();
    } else if (a === "--resume") {
      resume = true;
    } else if (a === "--list") {
      list = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { suite, limit, model, subModel, journal, oolongMaxCl, oolongLimit, oolongLabels, runs, maxIterations, temperature, list, poolOnly, taskIds, resume };
}

function printTasks(tasks: readonly BenchTask[]): void {
  for (const t of tasks) {
    console.log(`${t.suite}/${t.id}  context=${t.context.length} chars  grade=${t.grade.kind}`);
  }
}

/** Journal row → dedup key for --resume; tolerant of foreign/malformed lines (returns undefined). */
function resumeKeyOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const taskId = "taskId" in v ? v.taskId : undefined;
  const run = "run" in v ? v.run : undefined;
  const model = "model" in v ? v.model : undefined;
  if (typeof taskId !== "string" || typeof model !== "string" || typeof run !== "number") {
    return undefined;
  }
  return `${model}#${taskId}#${run}`;
}

/** Set of `model#taskId#run` keys already present in the journal file (fail-soft: empty on any error). */
function loadResumeSet(journalPath: string): Set<string> {
  const done = new Set<string>();
  try {
    const prior = readFileSync(journalPath, "utf8");
    for (const line of prior.split("\n")) {
      if (!line.trim()) continue;
      try {
        const key = resumeKeyOf(JSON.parse(line));
        if (key !== undefined) done.add(key);
      } catch {
        // malformed line — skip, never crash the run
      }
    }
  } catch {
    // no prior journal — resume from scratch
  }
  return done;
}

async function runTask(run: RunRlm, task: BenchTask, pricing: BenchPricing): Promise<Partial<BenchRow>> {
  const t0 = Date.now();
  const res = await run({ rootPrompt: task.prompt, context: task.context, depth: 0 });
  const outcome = gradeAnswer(task.grade, res.answer);
  // P2 §3.4 (last-resort fallback): the run ended with NO final frame but printed a value.
  // Grade the last stdout too and, if that is what won, say so on the row (`recovered`,
  // `answerSource`) — a silent swap would make every accuracy number unreadable.
  const stdout = res.lastStdout.trim();
  const fallback = stdout && !outcome.correct ? gradeAnswer(task.grade, stdout) : undefined;
  const useStdout = fallback !== undefined && fallback.correct;
  return {
    latencyMs: Date.now() - t0,
    correct: useStdout
      ? fallback.correct
      : outcome.correct,
    recall: useStdout ?
      fallback.recall
      : outcome.recall,
    answer: useStdout ? stdout : res.answer,
    recovered: useStdout,
    answerSource: useStdout ? "stdout" : "final",
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    iterations: res.iterations,
    // The engine no longer tracks USD — the runner prices the run from real per-token rates.
    costUsd: res.inputTokens * pricing.inputPerToken + res.outputTokens * pricing.outputPerToken,
  };
}

/** Free-pool upstreams fail whole runs instantly ("Provider finish_reason: error" before any
 *  turn is billed). The engine's retry classifier treats them as fatal, so the RUNNER retries
 *  the task — a bench row should mean "model failed the task", not "pool hiccuped". */
const TASK_ATTEMPTS = 4;
const TASK_RETRY_SLEEP_MS = 15_000;

async function runTaskWithRetries(run: RunRlm, task: BenchTask, pricing: BenchPricing): Promise<Partial<BenchRow>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTask(run, task, pricing);
    } catch (err) {
      if (attempt >= TASK_ATTEMPTS) throw err;
      console.log(`  ↻ ${task.suite}/${task.id} attempt ${attempt} failed (${err instanceof Error ? err.message.slice(0, 80) : String(err)}); retrying in ${TASK_RETRY_SLEEP_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, TASK_RETRY_SLEEP_MS));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // --oolong-labels is the CLI face; the env var is kept for parity with the other RLM_BENCH_*
  // knobs (weight-ladder shims). Either one flips the same labeled family (plan P0.1).
  const wantLabels = args.oolongLabels === true || process.env.RLM_BENCH_OOLONG_LABELS === "1";
  const pool = await buildTasks(args.suite, args.limit, {
    oolongMaxCl: args.oolongMaxCl,
    oolongLimit: args.oolongLimit,
    oolongLabels: wantLabels,
  });

  // P4.3: `--task-ids 550,551` keeps only the named tail of the pool (`oolong_550` …). Matching
  // is by suffix so the id form stays short on the command line. Unknown ids are reported, not
  // silently dropped — a typo would otherwise look like an empty (but successful) run.
  let tasks: readonly BenchTask[] = pool;
  if (args.taskIds !== undefined && args.taskIds.length > 0) {
    const wanted = args.taskIds;
    const kept = pool.filter((t) => wanted.some((id) => t.id === id || t.id.endsWith(`_${id}`)));
    const unmatched = wanted.filter((id) => !kept.some((t) => t.id === id || t.id.endsWith(`_${id}`)));
    if (unmatched.length > 0) console.log(`  task-ids: no task matched ${unmatched.join(", ")}`);
    console.log(`  task-ids: ${kept.length}/${pool.length} selected (${kept.map((t) => t.id).join(", ")})`);
    tasks = kept;
  }

  // --pool-only: the labeled-cache build is the slow, failure-prone part; this lets CI/dev
  // materialize + verify the pool without spending a single model token (plan P0.5).
  if (args.list || args.poolOnly) {
    if (args.poolOnly) {
      console.log(`[pool-only] ${tasks.length} tasks, labels=${wantLabels} — no model calls`);
    }
    printTasks(tasks);
    return;
  }

  const target = resolveTarget(args.model ?? process.env.RLM_BENCH_MODEL ?? DEFAULT_MODEL_REF);
  const apiKey = requireApiKey(target.provider);
  // Pricing catalog is OpenRouter-only; free-tier providers (zai) bench at zero cost.
  const pricing =
    target.provider === "openrouter"
      ? await fetchPricing(target.id)
      : { inputPerToken: 0, outputPerToken: 0 };
  const skillStateOn = process.env.RLM_BENCH_NO_SKILLSTATE !== "1";
  // Warmable store: point RLM_BENCH_SKILLSTATE_DIR at a prior run's dir to measure the warm
  // arm (notes harvested by that run ground this one). Default: fresh tmp dir per invocation.
  const skillDir = process.env.RLM_BENCH_SKILLSTATE_DIR ?? mkdtempSync(join(tmpdir(), "rlm-bench-ss-"));
  const skillStore = skillStateOn ? await SkillStore.hydrate(128, skillDir) : undefined;
  const run = makeRun(target, apiKey, {
    maxIterations: args.maxIterations,
    temperature: args.temperature,
    subModel: args.subModel,
    pricing,
    ...(skillStore === undefined ? {} : { skillStore }),
  });
  const journalPath = args.journal ?? `bench/runs/bench-${Date.now()}.jsonl`;

  // --resume: skip (model, task, run) triples already journaled — pooled runs stay crash-safe;
  // re-run the same command and only missing rows get produced (same journal file is reused).
  const resumed = args.resume ? loadResumeSet(journalPath) : new Set<string>();
  if (args.resume && resumed.size > 0) {
    console.log(`  resume: ${resumed.size} journaled rows found — already-done (task, run) pairs will be skipped`);
  }

  // GAP-4: record effective oolong selection opts in the header (journal schema unchanged).
  const oolongOpts = args.oolongMaxCl !== undefined || args.oolongLimit !== undefined
    ? `  oolong(max-cl=${args.oolongMaxCl ?? "default"}, limit=${args.oolongLimit ?? "default"})`
    : "";
  // P4.2: a journal is only readable if the run's configuration travels WITH it. The rows
  // carry model + suite; the knobs that explain a Δ (labels, max-iterations, skill-state,
  // pricing, git rev) do not. Sidecar `<journal>.config.json` + one console line.
  const configEcho = {
    gitRev: (() => {
      const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
      return (r.stdout ?? "").trim() || "unknown";
    })(),
    startedAt: new Date().toISOString(),
    model: target.ref,
    subModel: args.subModel ?? null,
    suite: args.suite,
    limit: args.limit ?? null,
    taskIds: args.taskIds ?? null,
    oolongMaxCl: args.oolongMaxCl ?? null,
    oolongLimit: args.oolongLimit ?? null,
    oolongLabels: wantLabels,
    runs: args.runs ?? 1,
    maxIterations: args.maxIterations ?? null,
    temperature: args.temperature ?? 0,
    skillState: skillStateOn,
    pricing,
  };
  const configPath = `${journalPath}.config.json`;
  const wroteConfig = ((): boolean => {
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(configEcho, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  })();
  console.log(
    `rlm bench  model=${target.ref}  suite=${args.suite}${args.limit !== undefined ? ` limit=${args.limit}` : ""}${oolongOpts}` +
      `  temp=${args.temperature ?? 0} runs=${args.runs ?? 1} iter=${args.maxIterations ?? "default"}` +
      `  labels=${wantLabels} skillstate=${skillStateOn}` +
      `  price(in/out)=${pricing.inputPerToken}/${pricing.outputPerToken} $/tok  journal=${journalPath}` +
      (wroteConfig ? `  config=${configPath}` : ""),
  );

  const rows: BenchRow[] = [];
  for (let runIndex = 1; runIndex <= (args.runs ?? 1); runIndex++) {
    for (const task of tasks) {
      if (resumed.has(`${target.ref}#${task.id}#${runIndex}`)) {
        console.log(`  = ${task.suite}/${task.id} run=${runIndex} skipped (already in journal)`);
        continue;
      }
      let row: BenchRow;
      try {
        const partial = await runTaskWithRetries(run, task, pricing);
        row = makeRow({
          suite: task.suite,
          taskId: task.id,
          model: target.ref,
          run: runIndex,
          ...(partial.correct !== undefined ? { correct: partial.correct } : { correct: false }),
          ...(partial.recall !== undefined ? { recall: partial.recall } : { recall: 0 }),
          ...(task.gold !== undefined ? { gold: task.gold } : {}),
          latencyMs: partial.latencyMs ?? Date.now(),
          inputTokens: partial.inputTokens ?? 0,
          outputTokens: partial.outputTokens ?? 0,
          iterations: partial.iterations ?? 0,
          costUsd: partial.costUsd ?? 0,
          ...(partial.answer !== undefined ? { answer: partial.answer } : { answer: "" }),
          // P2 §3.4: the fallback tag must reach the journal, else a recovered row is
          // indistinguishable from a real final-frame answer in every later report.
          ...(partial.recovered !== undefined ? { recovered: partial.recovered } : {}),
          ...(partial.answerSource !== undefined ? { answerSource: partial.answerSource } : {}),
        });
      } catch (err) {
        row = makeRow({
          suite: task.suite,
          taskId: task.id,
          model: target.ref,
          run: runIndex,
          correct: false,
          recall: 0,
          answer: "",
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          iterations: 0,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      rows.push(row);
      appendRow(journalPath, row);
      const mark = row.error !== undefined ? "!" : row.correct ? "✓" : "✗";
      const extra =
        row.error !== undefined ? ` error=${row.error.slice(0, 160)}` : ` gold=${row.gold ?? "-"}`;
      console.log(
        `  ${mark} ${task.suite}/${task.id}  correct=${row.correct} recall=${row.recall.toFixed(2)} ` +
          `${(row.latencyMs / 1000).toFixed(1)}s in=${row.inputTokens} out=${row.outputTokens} it=${row.iterations}${extra}`,
      );
    }
  }

  // ---- run summary: pooled totals, per-run subtotals + stability table (plan §2.2.5) ----
  if (skillStore !== undefined) {
    const flushed = await skillStore.flush();
    console.log(`  skillstore: notes=${skillStore.noteCount} dir=${skillDir} flushed=${flushed}`);
  }
  const totalIn = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.outputTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const nCorrect = rows.filter((r) => r.correct).length;
  console.log(`\ntokens in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(4)}`);

  const nRuns = args.runs ?? 1;
  if (nRuns > 1) {
    for (let ri = 1; ri <= nRuns; ri++) {
      const sub = rows.filter((r) => r.run === ri);
      console.log(
        `  run ${ri}: tasks=${sub.length} correct=${sub.filter((r) => r.correct).length}` +
          ` in=${sub.reduce((s, r) => s + r.inputTokens, 0)} out=${sub.reduce((s, r) => s + r.outputTokens, 0)}` +
          ` cost=$${sub.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`,
      );
    }
    const byTask = new Map<string, { passes: number; runs: number }>();
    for (const r of rows) {
      const st = byTask.get(r.taskId) ?? { passes: 0, runs: 0 };
      st.runs += 1;
      if (r.correct) st.passes += 1;
      byTask.set(r.taskId, st);
    }
    console.log("per-task stability:");
    for (const [taskId, st] of byTask) {
      const verdict = st.passes === st.runs ? "stable ✓" : st.passes === 0 ? "stable ✗" : `flaky ${st.passes}/${st.runs}`;
      console.log(`  ${taskId}  ${st.passes}/${st.runs}  ${verdict}`);
    }
  }

  const pct = rows.length > 0 ? ((nCorrect / rows.length) * 100).toFixed(1) : "0.0";
  console.log(`TOTAL tasks=${rows.length} correct=${nCorrect} (${pct}%)  in=${totalIn} out=${totalOut} cost=$${totalCost.toFixed(4)}`);
  console.log(`wrote ${journalPath} (${rows.length} rows)`);
}

main().catch((err: unknown) => {
  console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
