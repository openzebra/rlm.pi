/**
 * bench/debug-task.ts — run ONE bench task with full engine tracing (RLM_TRACE_FILE).
 *
 * Post-mortem tool: re-runs a single task so frame.in/frame.out sandbox traces can be
 * dissected without re-running a whole suite. Sampling is stochastic — a re-run may pass
 * where the journaled run failed; either way the call anatomy lands in the trace file.
 *
 * Usage (from repo root):
 *   RLM_TRACE_FILE=/tmp/t.jsonl OPENROUTER_API_KEY=… \
 *     bun run bench/debug-task.ts <model-ref> <taskId> [--ext]
 *
 *   --ext  selects the extended oolong suite (--oolong-max-cl 8192 --oolong-limit 6)
 */

import { makeRun, requireApiKey, resolveTarget } from "./engine.ts";
import { buildTasks } from "./tasks.ts";

const args = process.argv.slice(2);
const ext = args.includes("--ext");
const positional = args.filter((a) => !a.startsWith("--"));
const [modelRef, taskId] = positional;
if (modelRef === undefined || taskId === undefined) {
  throw new Error("usage: bun run bench/debug-task.ts <model-ref> <taskId> [--ext]");
}

const opts = ext ? { oolongMaxCl: 8192, oolongLimit: 6 } : {};
const tasks = await buildTasks("oolong", undefined, opts);
const task = tasks.find((t) => t.id === taskId);
if (task === undefined) throw new Error(`no task ${taskId}; have: ${tasks.map((t) => t.id).join(", ")}`);

const run = makeRun(resolveTarget(modelRef), requireApiKey());
console.log(
  `debug: ${task.id} (${task.context.length} chars) model=${modelRef} ` +
    `trace=${process.env.RLM_TRACE_FILE ?? "OFF"}`,
);
const res = await run({ rootPrompt: task.prompt, context: task.context, depth: 0 });
console.log(`answer: ${res.answer}`);
console.log(`it=${res.iterations} in=${res.inputTokens} out=${res.outputTokens} ${res.durationMs}ms`);
