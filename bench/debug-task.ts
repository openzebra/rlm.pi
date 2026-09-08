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
const REASONING_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"] as const);
type Reasoning = (typeof REASONING_LEVELS)[number];
const reasoningFlag = args.indexOf("--reasoning");
const reasoningArg = reasoningFlag !== -1 ? args[reasoningFlag + 1] : undefined;
if (reasoningArg !== undefined && !REASONING_LEVELS.includes(reasoningArg as Reasoning)) {
  throw new Error(`--reasoning must be one of ${REASONING_LEVELS.join("|")}, got: ${reasoningArg}`);
}
const reasoning = reasoningArg as Reasoning | undefined;
const positional = args.filter((a) => !a.startsWith("--") && a !== reasoningArg);
const [modelRef, taskId] = positional;
if (modelRef === undefined || taskId === undefined) {
  throw new Error("usage: bun run bench/debug-task.ts <model-ref> <taskId> [--ext] [--reasoning <level>]");
}

const opts = ext ? { oolongMaxCl: 8192, oolongLimit: 6 } : {};
const tasks = await buildTasks("oolong", undefined, opts);
const task = tasks.find((t) => t.id === taskId);
if (task === undefined) throw new Error(`no task ${taskId}; have: ${tasks.map((t) => t.id).join(", ")}`);

// Recipe parity: pass --reasoning to mirror the bench run being dissected (ab6 used high).
const run = makeRun(resolveTarget(modelRef), requireApiKey(), {
  temperature: 0,
  ...(reasoning !== undefined ? { reasoning } : {}),
});
console.log(
  `debug: ${task.id} (${task.context.length} chars) model=${modelRef} reasoning=${reasoning ?? "off"} ` +
    `trace=${process.env.RLM_TRACE_FILE ?? "OFF"}`,
);
const res = await run({ rootPrompt: task.prompt, context: task.context, depth: 0 });
console.log(`answer: ${res.answer}`);
console.log(`it=${res.iterations} in=${res.inputTokens} out=${res.outputTokens} ${res.durationMs}ms`);
