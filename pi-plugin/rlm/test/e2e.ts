/**
 * End-to-end: drive the REAL pi CLI with the RLM plugin against OpenRouter and print the full
 * trace — root reasoning, every repl() block, every sub-call / spawn / await.
 *
 *   bun run test:e2e "<task>" [--cwd dir] [--model ref] [--worker-model ref]
 *                             [--timeout s] [--stall s] [--keep]
 *
 * Requires OPENROUTER_API_KEY (env or pi-plugin/rlm/test/.env.e2e — never committed).
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  watch,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, failureCount } from "./helpers.ts";

const DEFAULT_MODEL = "openrouter/qwen/qwen3-32b";
const DEFAULT_STALL_S = 120;
const DEFAULT_TIMEOUT_S = 900;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "../..");

// ── env ───────────────────────────────────────────────────────────────────────

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(join(TEST_DIR, ".env.e2e"));

// ── args ──────────────────────────────────────────────────────────────────────

interface Args {
  readonly task: string;
  readonly cwd: string;
  readonly model: string;
  readonly workerModel: string;
  readonly timeoutS: number;
  readonly stallS: number;
  readonly keep: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let cwd = REPO_ROOT;
  let model = DEFAULT_MODEL;
  let workerModel = DEFAULT_MODEL;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let stallS = DEFAULT_STALL_S;
  let keep = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--cwd") {
      cwd = resolve(argv[++i] ?? cwd);
    } else if (a === "--model") {
      model = argv[++i] ?? model;
    } else if (a === "--worker-model") {
      workerModel = argv[++i] ?? workerModel;
    } else if (a === "--timeout") {
      timeoutS = Number(argv[++i] ?? timeoutS);
    } else if (a === "--stall") {
      stallS = Number(argv[++i] ?? stallS);
    } else if (a === "--keep") {
      keep = true;
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run test:e2e "<task>" [options]

Options:
  --cwd <dir>              Working directory (default: repo root)
  --model <ref>            Root model, provider/id (default: ${DEFAULT_MODEL})
  --worker-model <ref>     RLM worker model (default: same as --model)
  --timeout <s>            Hard kill after N seconds (default: ${DEFAULT_TIMEOUT_S})
  --stall <s>              Stall watchdog: no activity for N seconds (default: ${DEFAULT_STALL_S})
  --keep                   Keep artifacts even on success
`);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else {
      positionals.push(a);
    }
  }

  const task = positionals.join(" ").trim();
  if (!task) {
    console.error('Missing task. Example: bun run test:e2e "Summarize src/sandbox"');
    process.exit(2);
  }
  return Object.freeze({ task, cwd, model, workerModel, timeoutS, stallS, keep });
}

// ── run dir ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (!process.env.OPENROUTER_API_KEY) {
  console.error(
    "OPENROUTER_API_KEY is required (env or pi-plugin/rlm/test/.env.e2e).",
  );
  process.exit(2);
}

const runDir = join(
  REPO_ROOT,
  ".rlm-e2e",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const agentDir = join(runDir, "agent");
const sessionsDir = join(runDir, "sessions");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

// Pin the worker model + keep the run cheap and bounded. loadSettings() reads exactly this shape.
writeFileSync(
  join(agentDir, "rlm.json"),
  `${JSON.stringify({
    worker: args.workerModel,
    config: {
      enabled: true,
      maxDepth: 2,
      maxConcurrentSubcalls: 6,
      maxBudgetUsd: 0.5,
      runLog: { enabled: false },
    },
  }, null, 2)}\n`,
);

// The key reaches the child through the inherited environment only (pi-ai's envApiKeyAuth
// resolves OPENROUTER_API_KEY). Deliberately NOT written to the run's auth.json: a harness
// should not leave a live credential on disk.

const tracePath = join(runDir, "rlm-trace.jsonl");
const eventsPath = join(runDir, "events.jsonl");
const logPath = join(runDir, "trace.log");
// Truncate so the plugin starts clean.
writeFileSync(tracePath, "");
writeFileSync(eventsPath, "");
writeFileSync(logPath, "");

// ── child ─────────────────────────────────────────────────────────────────────

const slash = args.model.indexOf("/");
const provider = slash >= 0 ? args.model.slice(0, slash) : args.model;
const modelId = slash >= 0 ? args.model.slice(slash + 1) : args.model;

const piBin = join(REPO_ROOT, "node_modules/.bin/pi");
const pluginEntry = join(PLUGIN_ROOT, "src/index.ts");

const t0 = Date.now();
const child: ChildProcess = spawn(
  piBin,
  [
    "-p",
    "--mode", "json",
    "--provider", provider,
    "--model", modelId,
    "--rlm",
    "-e", pluginEntry,
    "--approve",
    "--session-dir", sessionsDir,
    args.task,
  ],
  {
    cwd: args.cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      RLM_TRACE_FILE: tracePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// ── two streams, one timeline ─────────────────────────────────────────────────

interface Row {
  readonly t: number;
  readonly line: string;
  readonly source: "pi" | "rlm";
}

let lastActivity = Date.now();
let stalled = false;
let finalText = "";
let lastProviderError = "";
const thinkingBuf: string[] = [];
const textBuf: string[] = [];

interface Stats {
  execs: number;
  execsRaised: number;
  subcallsDone: number;
  subcallsError: number;
  maxBatchSize: number;
  batchesDone: number;
  spawned: number;
  awaited: number;
  costUsd: number;
  tokens: number;
  byKind: { llm: number; batch: number; rlm: number };
}

const stats: Stats = {
  execs: 0,
  execsRaised: 0,
  subcallsDone: 0,
  subcallsError: 0,
  maxBatchSize: 0,
  batchesDone: 0,
  spawned: 0,
  awaited: 0,
  costUsd: 0,
  tokens: 0,
  byKind: { llm: 0, batch: 0, rlm: 0 },
};

const recentRows: Row[] = [];
const MAX_RECENT = 40;

function relLabel(t: number): string {
  return `t+${((t - t0) / 1000).toFixed(1)}s`;
}

function render(row: Row): void {
  lastActivity = Date.now();
  recentRows.push(row);
  if (recentRows.length > MAX_RECENT) recentRows.shift();
  console.log(row.line);
  try {
    appendFileSync(logPath, `${row.line}\n`);
  } catch {
    /* ignore */
  }
}

function emit(source: "pi" | "rlm", line: string): void {
  render({ t: Date.now(), line: `[${relLabel(Date.now())}] ${line}`, source });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function flushThinking(): void {
  if (thinkingBuf.length === 0) return;
  const text = thinkingBuf.join("").trim();
  thinkingBuf.length = 0;
  if (text) emit("pi", `▸ think   ${JSON.stringify(text.slice(0, 200))}`);
}

function flushText(): void {
  if (textBuf.length === 0) return;
  const text = textBuf.join("");
  textBuf.length = 0;
  finalText += text;
  const preview = text.trim();
  if (preview) emit("pi", `▸ text    ${JSON.stringify(preview.slice(0, 200))}`);
}

function handlePiEvent(raw: string): void {
  try {
    appendFileSync(eventsPath, `${raw}\n`);
  } catch {
    /* ignore */
  }
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(ev) || typeof ev.type !== "string") return;
  const type = ev.type;

  if (type === "message_update" && isRecord(ev.assistantMessageEvent)) {
    const ame = ev.assistantMessageEvent;
    const delta = asString(ame.delta);
    if (ame.type === "thinking_delta" && delta) {
      thinkingBuf.push(delta);
      lastActivity = Date.now();
    } else if (ame.type === "text_delta" && delta) {
      textBuf.push(delta);
      lastActivity = Date.now();
    }
    return;
  }

  if (type === "message_end" || type === "turn_end" || type === "agent_end") {
    flushThinking();
    flushText();
    // Provider failures (401, rate limits, context overflow) arrive as a stopReason on the
    // message, not on stdout — without this the run just ends early and every check fails
    // with no visible cause.
    const message = isRecord(ev.message) ? ev.message : undefined;
    const stop = asString(message?.stopReason);
    if (stop === "error" || stop === "aborted") {
      const reason = asString(message?.errorMessage) || stop;
      if (reason !== lastProviderError) {
        lastProviderError = reason;
        emit("pi", `✗ provider ${stop}: ${reason.slice(0, 200)}`);
      }
    }
    if (type !== "agent_end") return;
  }

  if (type === "tool_execution_start") {
    flushThinking();
    flushText();
    const name = asString(ev.toolName);
    const args = isRecord(ev.args) ? ev.args : {};
    if (name === "repl") {
      const code = asString(args.code);
      emit("pi", `▸ repl    ${code.slice(0, 120).replace(/\n/g, " ")}`);
    } else {
      emit("pi", `▸ tool    ${name}`);
    }
    return;
  }

  if (type === "tool_execution_end") {
    const name = asString(ev.toolName);
    const isError = ev.isError === true;
    const result = ev.result;
    let detail = "";
    if (isRecord(result) && isRecord(result.details)) {
      const d = result.details;
      const ms = typeof d.executionTimeMs === "number" ? d.executionTimeMs : 0;
      const sc = Array.isArray(d.subcalls) ? d.subcalls.length : 0;
      const bg = typeof d.backgroundPending === "number" ? d.backgroundPending : 0;
      detail = ` ${ms}ms · ${sc} subcall${sc === 1 ? "" : "s"}${bg > 0 ? ` · ↯${bg} bg` : ""}`;
    }
    emit("pi", `${isError ? "✗" : "◂"} ${name.padEnd(6)} ${isError ? "error" : "done"}${detail}`);
    return;
  }

  if (type === "agent_end") {
    emit("pi", "◼ agent_end");
    return;
  }

  if (type === "auto_retry_start") {
    emit("pi", `↻ retry   attempt ${ev.attempt}/${ev.maxAttempts}: ${asString(ev.errorMessage).slice(0, 120)}`);
  }
}

function handleTraceLine(raw: string): void {
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(ev) || typeof ev.kind !== "string") return;
  const kind = ev.kind;
  lastActivity = Date.now();

  if (kind === "repl.exec.start") {
    stats.execs += 1;
    emit("rlm", `  ↳ repl.exec.start  chars=${ev.chars ?? "?"}`);
    return;
  }
  if (kind === "repl.exec.end") {
    const err = asString(ev.error);
    if (ev.raised === true) stats.execsRaised += 1;
    emit(
      "rlm",
      `  ↳ repl.exec.end    ${ev.ms ?? "?"}ms  raised=${ev.raised}  pending=${ev.pending ?? 0}`
        + (err ? `\n            ✗ ${err}` : ""),
    );
    return;
  }
  if (kind === "subcall.created") {
    const label = asString(ev.label);
    const model = asString(ev.model);
    const scope = asString(ev.scope);
    const id = asString(ev.id);
    const scKind = asString(ev.kind);
    if (scKind === "batch") {
      const m = /×(\d+)/.exec(label);
      if (m) {
        const n = Number(m[1]);
        if (n > stats.maxBatchSize) stats.maxBatchSize = n;
      }
    }
    if (scope === "background" || id.startsWith("bg")) stats.spawned += 1;
    emit(
      "rlm",
      `  ↳ spawn ${label}${model ? `  → ${model}` : ""}  [${id || scope}]`,
    );
    return;
  }
  if (kind === "subcall.updated") {
    const status = asString(ev.status);
    const id = asString(ev.id);
    const cost = typeof ev.costUsd === "number" ? ev.costUsd : 0;
    const tokens = typeof ev.tokens === "number" ? ev.tokens : 0;
    stats.costUsd += cost;
    stats.tokens += tokens;
    if (status === "done") {
      stats.subcallsDone += 1;
      if (id.startsWith("bg")) stats.awaited += 1;
      // Batch label is only on create; count done updates as completed nodes.
      if (typeof ev.totalCount === "number" && ev.totalCount > 1) {
        stats.batchesDone += 1;
        stats.byKind.batch += 1;
      }
    } else if (status === "error") {
      stats.subcallsError += 1;
    }
    if (status === "done" || status === "error") {
      emit(
        "rlm",
        `  ↳ ${status.padEnd(5)} [${id}]` +
          (cost > 0 || tokens > 0
            ? `  $${cost.toFixed(4)}  ${tokens} tok`
            : "") +
          (ev.detail ? `  ${asString(ev.detail).slice(0, 80)}` : ""),
      );
    }
    return;
  }
  if (kind === "bg.start") {
    emit("rlm", `  ↳ bg.start   pending=${ev.pending}`);
    return;
  }
  if (kind === "bg.settle") {
    emit("rlm", `  ↳ bg.settle  pending=${ev.pending}  ${ev.durationMs ?? "?"}ms`);
    return;
  }
  if (kind === "frame.in" && ev.detached === true) {
    emit(
      "rlm",
      `  ↳ frame.in  ${ev.frame}  detached  prompts=${ev.prompts ?? 1}  rid=${ev.rid}`,
    );
  }
}

// pi stdout → JSONL events
let piBuf = "";
child.stdout?.setEncoding("utf8");
child.stdout?.on("data", (chunk: string) => {
  piBuf += chunk;
  let nl: number;
  while ((nl = piBuf.indexOf("\n")) >= 0) {
    const line = piBuf.slice(0, nl).trim();
    piBuf = piBuf.slice(nl + 1);
    if (line) handlePiEvent(line);
  }
});

// pi stderr → pass through (auth errors, extension errors)
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk: string) => {
  lastActivity = Date.now();
  const text = chunk.trimEnd();
  if (text) {
    console.error(text);
    try {
      appendFileSync(logPath, `[stderr] ${text}\n`);
    } catch {
      /* ignore */
    }
  }
});

// RLM trace file — tail via watch (plugin appends from the child process)
let traceOffset = 0;
function drainTrace(): void {
  if (!existsSync(tracePath)) return;
  let data: string;
  try {
    data = readFileSync(tracePath, "utf8");
  } catch {
    return;
  }
  if (data.length <= traceOffset) return;
  const fresh = data.slice(traceOffset);
  traceOffset = data.length;
  for (const line of fresh.split("\n")) {
    if (line.trim()) handleTraceLine(line.trim());
  }
}

const watcher = existsSync(tracePath)
  ? watch(tracePath, () => {
      drainTrace();
    })
  : undefined;
const pollTrace = setInterval(drainTrace, 250);

function dumpLastEvents(n: number): void {
  console.error("\n── last activity ──");
  for (const row of recentRows.slice(-n)) {
    console.error(row.line);
  }
  // In-flight from the trace file
  try {
    const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
    const created = new Map<string, string>();
    const done = new Set<string>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e.kind === "subcall.created" && typeof e.id === "string") {
          created.set(e.id, asString(e.label));
        }
        if (
          e.kind === "subcall.updated" &&
          typeof e.id === "string" &&
          (e.status === "done" || e.status === "error")
        ) {
          done.add(e.id);
        }
      } catch {
        /* ignore */
      }
    }
    const inflight = [...created.entries()].filter(([id]) => !done.has(id));
    if (inflight.length > 0) {
      console.error("\n── in-flight subcalls ──");
      for (const [id, label] of inflight) console.error(`  ${id}  ${label}`);
    }
  } catch {
    /* ignore */
  }
}

// ── stall watchdog = the deadlock detector ────────────────────────────────────

const stall = setInterval(() => {
  if (Date.now() - lastActivity < args.stallS * 1000) return;
  clearInterval(stall);
  stalled = true;
  console.error(
    `\n✗ STALL: no pi event and no RLM trace line for ${args.stallS}s — possible deadlock`,
  );
  dumpLastEvents(20);
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}, 1_000);

const hardTimeout = setTimeout(() => {
  console.error(`\n✗ TIMEOUT: exceeded ${args.timeoutS}s hard limit`);
  stalled = true;
  dumpLastEvents(20);
  try {
    child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}, args.timeoutS * 1000);

// ── wait for child ────────────────────────────────────────────────────────────

const exitCode: number = await new Promise((resolveExit) => {
  child.on("error", (err) => {
    console.error("failed to spawn pi:", err);
    resolveExit(1);
  });
  child.on("close", (code) => {
    resolveExit(code ?? 1);
  });
});

clearInterval(stall);
clearInterval(pollTrace);
clearTimeout(hardTimeout);
watcher?.close();
drainTrace();
flushThinking();
flushText();

// Recompute stats from the full trace (live counters can miss watch-raced lines).
try {
  const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
  let llm = 0;
  let batch = 0;
  let rlm = 0;
  let maxBatch = 0;
  let batchesDone = 0;
  let done = 0;
  let err = 0;
  let cost = 0;
  let tokens = 0;
  let execs = 0;
  let raised = 0;
  let spawned = 0;
  let awaited = 0;
  const kindById = new Map<string, string>();

  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      const k = asString(e.kind);
      if (k === "repl.exec.start") execs += 1;
      if (k === "repl.exec.end" && e.raised === true) raised += 1;
      if (k === "bg.start") spawned += 1;
      if (k === "subcall.created") {
        const id = asString(e.id);
        const label = asString(e.label);
        const scKind = asString(e.subcallKind);
        if (id) kindById.set(id, scKind);
        if (scKind === "llm") llm += 1;
        else if (scKind === "batch") {
          batch += 1;
          const m = /×(\d+)/.exec(label);
          if (m) maxBatch = Math.max(maxBatch, Number(m[1]));
        } else if (scKind === "rlm") rlm += 1;
      }
      if (k === "subcall.updated") {
        if (e.status === "done") {
          done += 1;
          const id = asString(e.id);
          if (id.startsWith("bg")) awaited += 1;
          const total = typeof e.totalCount === "number" ? e.totalCount : 0;
          if (total > 1 || kindById.get(id) === "batch") batchesDone += 1;
        }
        if (e.status === "error") err += 1;
        if (typeof e.costUsd === "number") cost += e.costUsd;
        if (typeof e.tokens === "number") tokens += e.tokens;
      }
    } catch {
      /* ignore */
    }
  }
  stats.execs = Math.max(stats.execs, execs);
  stats.execsRaised = Math.max(stats.execsRaised, raised);
  stats.subcallsDone = Math.max(stats.subcallsDone, done);
  stats.subcallsError = Math.max(stats.subcallsError, err);
  stats.byKind = { llm, batch, rlm };
  stats.maxBatchSize = Math.max(stats.maxBatchSize, maxBatch);
  stats.batchesDone = Math.max(stats.batchesDone, batchesDone);
  stats.spawned = Math.max(stats.spawned, spawned);
  stats.awaited = Math.max(stats.awaited, awaited);
  stats.costUsd = Math.max(stats.costUsd, cost);
  stats.tokens = Math.max(stats.tokens, tokens);
} catch {
  /* ignore */
}

// ── assertions + summary ──────────────────────────────────────────────────────

check("e2e — pi exited cleanly", exitCode === 0, `exit=${exitCode}`);
check("e2e — no stall detected", !stalled);
check("e2e — at least one repl() execution", stats.execs > 0, `${stats.execs}`);
check(
  "e2e — at least one sub-call completed",
  stats.subcallsDone > 0,
  stats.subcallsDone > 0
    ? `${stats.subcallsDone}`
    : `no delegation happened${stats.execsRaised > 0 ? ` — ${stats.execsRaised}/${stats.execs} repl block(s) raised (see trace)` : ""}`,
);
check(
  "e2e — batch fan-out ran without deadlock",
  stats.maxBatchSize === 0 || stats.batchesDone > 0 || stats.subcallsDone > 0,
  `maxBatch=${stats.maxBatchSize} batchesDone=${stats.batchesDone}`,
);
check(
  "e2e — no provider error",
  lastProviderError === "",
  lastProviderError || "none",
);
check("e2e — final answer produced", finalText.trim().length > 0);

const summary = {
  exitCode,
  stalled,
  providerError: lastProviderError || undefined,
  stats,
  finalTextPreview: finalText.trim().slice(0, 500),
  wallTimeS: (Date.now() - t0) / 1000,
  artifacts: runDir,
};
writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`
─── summary ───────────────────────────────
 repl executions   ${stats.execs} (${stats.execsRaised} raised)
 sub-calls         ${stats.subcallsDone} done / ${stats.subcallsError} error
   llm_query       ${stats.byKind.llm}
   batches         ${stats.byKind.batch} (max ${stats.maxBatchSize} prompts)
   rlm_query       ${stats.byKind.rlm}
 spawned (bg)      ${stats.spawned} started / ${stats.awaited} awaited
 cost              $${stats.costUsd.toFixed(4)}   tokens ${stats.tokens}
 wall time         ${((Date.now() - t0) / 1000).toFixed(1)}s
 artifacts         ${runDir}
───────────────────────────────────────────`);

const failures = failureCount();
if (failures > 0 && !args.keep) {
  // Keep artifacts on failure for post-mortem.
  console.error(`(artifacts kept at ${runDir})`);
}

process.exit(failures > 0 ? 1 : 0);
