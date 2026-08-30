/**
 * bench/run.ts — e2e benchmark driver for THIS project's RLM engine.
 *
 * Drives pi-plugin/rlm's headless engine (`createEngine`) against real OpenRouter models with
 * the task suites ported from the rlm_test lab (needle / codeqa / coding).
 *
 * Env vars (the only key transport — never hardcode keys, never commit them):
 *   OPENROUTER_API_KEY        required
 *   RLM_BENCH_MODEL           optional, default openrouter/poolside/laguna-xs-2.1:free
 *   RLM_BENCH_CONTEXT_WINDOW  optional, default 262144
 *
 * Usage (from the repo root):
 *   bun run bench/run.ts                      # all suites
 *   bun run bench/run.ts --suite needle       # one suite: needle|codeqa|coding|all
 *   bun run bench/run.ts --limit 1            # first task per suite only
 *   bun run bench/run.ts --suite oolong --oolong-max-cl 65536 --oolong-limit 24
 *                                             # extended oolong: context_len cap / task count
 *   bun run bench/run.ts --model openrouter/google/gemma-4-31b-it:free
 *   bun run bench/run.ts --list               # print tasks + context sizes, no engine
 *
 * Artifacts: JSONL journal bench/runs/bench-<ts>.jsonl — journal only, no aggregate report.
 */

import { appendRow, makeRow, type BenchRow } from "./journal.ts";
import { gradeAnswer } from "./grade.ts";
import { DEFAULT_MODEL_REF, makeRun, requireApiKey, resolveTarget } from "./engine.ts";
import { buildTasks, type BenchTask, type SuiteName } from "./tasks.ts";
import type { RunRlm } from "../pi-plugin/rlm/src/core/types.ts";

interface Args {
  readonly suite: SuiteName | "all" | "paper";
  readonly limit?: number;
  readonly model?: string;
  readonly journal?: string;
  readonly oolongMaxCl?: number;
  readonly oolongLimit?: number;
  readonly list: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let suite: SuiteName | "all" | "paper" = "all";
  let limit: number | undefined;
  let model: string | undefined;
  let journal: string | undefined;
  let oolongMaxCl: number | undefined;
  let oolongLimit: number | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      i++;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--suite") {
      const v = next();
      const valid = new Set(["all", "paper", "needle", "codeqa", "coding", "s_niah", "oolong", "browsecomp", "codeqa_lb"]);
      if (!valid.has(v)) {
        throw new Error(`--suite must be all|paper|needle|codeqa|coding|s_niah|oolong|browsecomp|codeqa_lb, got: ${v}`);
      }
      suite = v as Args["suite"];
    } else if (a === "--limit") {
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
    } else if (a === "--model") {
      model = next();
    } else if (a === "--journal") {
      journal = next();
    } else if (a === "--list") {
      list = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { suite, limit, model, journal, oolongMaxCl, oolongLimit, list };
}

function printTasks(tasks: readonly BenchTask[]): void {
  for (const t of tasks) {
    console.log(`${t.suite}/${t.id}  context=${t.context.length} chars  grade=${t.grade.kind}`);
  }
}

async function runTask(run: RunRlm, task: BenchTask): Promise<Partial<BenchRow>> {
  const t0 = Date.now();
  const res = await run({ rootPrompt: task.prompt, context: task.context, depth: 0 });
  const outcome = gradeAnswer(task.grade, res.answer);
  return {
    latencyMs: Date.now() - t0,
    correct: outcome.correct,
    recall: outcome.recall,
    answer: res.answer,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    iterations: res.iterations,
    costUsd: res.costUsd,
  };
}

/** Free-pool upstreams fail whole runs instantly ("Provider finish_reason: error" before any
 *  turn is billed). The engine's retry classifier treats them as fatal, so the RUNNER retries
 *  the task — a bench row should mean "model failed the task", not "pool hiccuped". */
const TASK_ATTEMPTS = 4;
const TASK_RETRY_SLEEP_MS = 15_000;

async function runTaskWithRetries(run: RunRlm, task: BenchTask): Promise<Partial<BenchRow>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTask(run, task);
    } catch (err) {
      if (attempt >= TASK_ATTEMPTS) throw err;
      console.log(`  ↻ ${task.suite}/${task.id} attempt ${attempt} failed (${err instanceof Error ? err.message.slice(0, 80) : err}); retrying in ${TASK_RETRY_SLEEP_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, TASK_RETRY_SLEEP_MS));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = await buildTasks(args.suite, args.limit, {
    oolongMaxCl: args.oolongMaxCl,
    oolongLimit: args.oolongLimit,
  });

  if (args.list) {
    printTasks(tasks);
    return;
  }

  const apiKey = requireApiKey();
  const target = resolveTarget(args.model ?? process.env.RLM_BENCH_MODEL ?? DEFAULT_MODEL_REF);
  const run = makeRun(target, apiKey);
  const journalPath = args.journal ?? `bench/runs/bench-${Date.now()}.jsonl`;

  // GAP-4: record effective oolong selection opts in the header (journal schema unchanged).
  const oolongOpts = args.oolongMaxCl !== undefined || args.oolongLimit !== undefined
    ? `  oolong(max-cl=${args.oolongMaxCl ?? "default"}, limit=${args.oolongLimit ?? "default"})`
    : "";
  console.log(`rlm bench  model=${target.ref}  suite=${args.suite}${args.limit !== undefined ? ` limit=${args.limit}` : ""}${oolongOpts}  journal=${journalPath}`);

  const rows: BenchRow[] = [];
  for (const task of tasks) {
    let row: BenchRow;
    try {
      const partial = await runTaskWithRetries(run, task);
      row = makeRow({
        suite: task.suite,
        taskId: task.id,
        model: target.ref,
        ...(partial.correct !== undefined ? { correct: partial.correct } : { correct: false }),
        ...(partial.recall !== undefined ? { recall: partial.recall } : { recall: 0 }),
        ...(task.gold !== undefined ? { gold: task.gold } : {}),
        latencyMs: partial.latencyMs ?? Date.now(),
        inputTokens: partial.inputTokens ?? 0,
        outputTokens: partial.outputTokens ?? 0,
        iterations: partial.iterations ?? 0,
        costUsd: partial.costUsd ?? 0,
        ...(partial.answer !== undefined ? { answer: partial.answer } : { answer: "" }),
      });
    } catch (err) {
      row = makeRow({
        suite: task.suite,
        taskId: task.id,
        model: target.ref,
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

  console.log(`\nwrote ${journalPath} (${rows.length} rows)`);
}

main().catch((err: unknown) => {
  console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
