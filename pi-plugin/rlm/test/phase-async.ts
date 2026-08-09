/**
 * Phase-async verification — spawn() / await_task / await_task, the concurrency gates,
 * the background-task registry, and the watchdog heartbeat.
 *
 * Drives PythonSandbox directly with fake handlers (no pi, no real LLM).
 * Run: bun run pi-plugin/rlm/test/phase-async.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { DepthGates, Semaphore } from "../src/util/concurrency.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { SubcallStore } from "../src/tool/subcall-store.ts";
import { BackgroundTasks } from "../src/tool/background-tasks.ts";
import { renderCollapsedSubcallTree } from "../src/tool/subcall-render.ts";
import { buildReplResultText } from "../src/tool/repl-result.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { NATIVE_PROMPT_BUDGET, NATIVE_PROMPT_STATIC } from "../src/prompts/native.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Minimal Theme stand-in — the tree renderer only needs fg/bold to return strings. */
const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// ── 1–2. Overlap and ordering ────────────────────────────────────────────────────────────

async function testOverlapAndOrder(): Promise<void> {
  let peak = 0;
  let active = 0;
  const sb = await PythonSandbox.spawn({
    depth: 1,
    handlers: {
      llmQuery: async (prompt) => {
        active += 1;
        peak = Math.max(peak, active);
        const idx = Number(prompt);
        // Completion order is the REVERSE of input order.
        await sleep(240 - idx * 20);
        active -= 1;
        return `r${idx}`;
      },
    },
  });
  try {
    const started = Date.now();
    const res = await sb.exec(`
ts = [spawn(llm_query, str(i)) for i in range(5)]
print(await_task(ts))
`);
    const elapsed = Date.now() - started;
    // Serial would be 240+220+200+180+160 = 1000ms; concurrent is bounded by the slowest.
    check("spawned sub-calls overlap", elapsed < 700, `${elapsed}ms (serial ≈ 1000ms)`);
    check("all 5 in flight at once", peak === 5, `peak=${peak}`);
    check(
      "await_task preserves input order despite reversed completion",
      res.stdout.trim() === "['r0', 'r1', 'r2', 'r3', 'r4']",
      res.stdout.trim(),
    );

    const idem = await sb.exec(`
t = spawn(llm_query, "9")
a = await_task(t)
b = await_task(t)
print(a, b, t.done)
`);
    check("await_task is idempotent and memoized", idem.stdout.trim() === "r9 r9 True", idem.stdout.trim());

    const misuse = await sb.exec(`
print(await_task(spawn(print, "x")))
print(await_task("not a task"))
`);
    check("spawn() of a non-spawnable fn returns an Error string",
      misuse.stdout.includes("Error: spawn() takes"), misuse.stdout.split("\n")[0]?.slice(0, 60));
    check("await_task of a non-Task returns an Error string",
      misuse.stdout.includes("expects a Task"), "");
    check("misuse never raises", !misuse.raised, misuse.stderr.slice(0, 120));

    // llm_map_reduce cannot be a single Task (its reduce depends on its own map results) — the
    // error must SAY so, since the glossary lists it right next to the spawnable helpers.
    const mapReduce = await sb.exec(`print(await_task(spawn(llm_map_reduce, ["a"], "map", "reduce")))`);
    check("spawn(llm_map_reduce) explains why it is excluded",
      mapReduce.stdout.includes("not llm_map_reduce"), mapReduce.stdout.trim().slice(0, 80));

    // Empty prompts: a sub-LLM asked nothing confabulates, and the confabulation looks like data.
    const blank = await sb.exec(
      `print(await_task(llm_query("   ")))\nprint(await_task(llm_batch(["", " "]))[0])`,
    );
    check("llm_query('') is refused instead of answered",
      blank.stdout.includes("empty prompt"), blank.stdout.trim().slice(0, 80));
    check("an all-blank batch is refused per prompt",
      blank.stdout.includes("only empty prompts"), "");

    // A Task left unawaited must not wedge the worker for the next exec.
    await sb.exec(`leftover = spawn(llm_query, "3")`);
    const afterSpawn = await sb.exec(`print("still alive")`);
    check("an unawaited Task does not block the next exec", afterSpawn.stdout.includes("still alive"), afterSpawn.stderr.slice(0, 120));
    await sb.exec(`await_task(leftover)`);
  } finally {
    await sb.dispose();
  }
}

// ── 3. Cross-turn: the keystone ──────────────────────────────────────────────────────────

async function testCrossTurn(): Promise<void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let entered = false;
  const sb = await PythonSandbox.spawn({
    depth: 1,
    handlers: {
      rlmQuery: async () => { entered = true; await gate; return "late-answer"; },
    },
  });
  try {
    const spawnTurn = await sb.exec(`t = spawn(rlm_query, "x"); print("spawned", t.done)`);
    check("exec returns while the spawned handler is still running",
      spawnTurn.stdout.trim() === "spawned False" && entered, spawnTurn.stdout.trim());

    const between = await sb.exec(`print("unrelated turn")`);
    check("an unrelated exec runs while the task is in flight",
      between.stdout.trim() === "unrelated turn", between.stdout.trim());

    // The reply now lands while the worker is idle in main() — it must be parked, not
    // answered with "unknown type". This is what makes cross-turn awaits possible.
    release();
    await sleep(150);
    const awaitTurn = await sb.exec(`print(await_task(t))`);
    check("CROSS-TURN: a reply parked between turns is recovered",
      awaitTurn.stdout.trim() === "late-answer", awaitTurn.stdout.trim());
  } finally {
    await sb.dispose();
  }
}

// ── 7. Chunked fan-out is concurrent, and the sync contract is unchanged ─────────────────

async function testChunkedConcurrency(): Promise<void> {
  const sizes: number[] = [];
  let peak = 0;
  let active = 0;
  const sb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 10_000,
    handlers: {
      llmBatch: async (prompts) => {
        active += 1;
        peak = Math.max(peak, active);
        sizes.push(prompts.length);
        await sleep(120);
        active -= 1;
        return prompts.map((_, i) => `c${i}`);
      },
    },
  });
  try {
    // budget = 10000 - len("Q") - 64 = 9935 chars/chunk → 55 chunks → batches of 20/20/15.
    const started = Date.now();
    const res = await sb.exec(`print(len(llm_query_chunked("x" * 540_000, "Q")))`);
    const elapsed = Date.now() - started;
    check("chunked returns one answer per chunk", res.stdout.trim() === "55", res.stdout.trim());
    check("chunked batches are dispatched CONCURRENTLY",
      peak === 3 && elapsed < 300,
      `sizes=${JSON.stringify(sizes)} peak=${peak} ${elapsed}ms (sequential ≈ 360ms)`);
  } finally {
    await sb.dispose();
  }
}

// ── 8. Gates bound concurrency and do not deadlock on recursion ──────────────────────────

async function testGates(): Promise<void> {
  const sem = new Semaphore(8);
  let peak = 0;
  let active = 0;
  // Order-preserving parallel map via run + Promise.all (Semaphore.map was removed — it
  // invited the re-entrant deadlock that phase-batch-gate locks out).
  const out = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return i * 2;
    }),
  ));
  check("Semaphore never exceeds its limit", peak <= 8, `peak=${peak}`);
  check("Semaphore.run + Promise.all preserves order", out[0] === 0 && out[49] === 98, `${out[0]}..${out[49]}`);

  // A single shared gate at limit 1 would deadlock here: the depth-0 holder waits forever
  // for a slot its own child needs. Per-depth gates break the cycle.
  const gates = new DepthGates(1);
  const nested = await gates.at(0).run(async () => gates.at(1).run(async () => "inner"));
  check("DepthGates: a holder can spawn a deeper child without deadlock", nested === "inner", nested);
}

// ── 9–11. Background registry: ID namespacing, subtree drain, un-awaited cost ────────────

function testBackgroundRegistry(): void {
  // IDs from a second emitter must not collide with a turn emitter's s1, s2, …
  const turn = new RlmEmitter();
  const bg = new RlmEmitter("bg");
  check("turn emitter keeps its s-prefixed IDs",
    turn.emitSubcallCreated({ kind: "llm", label: "a", depth: 0 }) === "s1", "");
  check("background emitter IDs cannot collide with turn IDs",
    bg.emitSubcallCreated({ kind: "llm", label: "b", depth: 0 }) === "bg1", "");

  // A settled root whose child is still running must NOT be handed over: the tree renderer
  // walks down from parentId === undefined and silently drops orphans.
  const emitter = new RlmEmitter("bg");
  const store = new SubcallStore(emitter);
  const rootId = emitter.emitSubcallCreated({ kind: "rlm", label: "rlm_query", depth: 1 });
  const childId = emitter.emitSubcallCreated({ kind: "llm", label: "llm_query", parentId: rootId, depth: 2 });
  emitter.emitSubcallUpdated({ id: rootId, status: "done", costUsd: 0.02, tokens: 200 });

  const early = store.takeSettledSubtrees();
  check("a root with a running descendant is withheld", early.subcalls.length === 0, `${early.subcalls.length}`);

  emitter.emitSubcallUpdated({ id: childId, status: "done", costUsd: 0.01, tokens: 100 });
  const drained = store.takeSettledSubtrees();
  check("the whole subtree comes over once it settles", drained.subcalls.length === 2, `${drained.subcalls.length}`);
  check("drained totals cover the subtree",
    Math.abs(drained.totals.costUsd - 0.03) < 1e-9 && drained.totals.tokens === 300,
    `$${drained.totals.costUsd} / ${drained.totals.tokens} tok`);
  check("drained totals are removed from the store's running totals",
    store.getTotals().costUsd === 0 && store.getTotals().tokens === 0,
    `$${store.getTotals().costUsd}`);
  check("a drained subtree is not handed over twice",
    store.takeSettledSubtrees().subcalls.length === 0, "");

  // The adopted subtree must actually render — the r1 blocker was that it would not.
  const tree = renderCollapsedSubcallTree(drained.subcalls, PLAIN_THEME);
  check("the adopted subtree renders (root and child both present)",
    tree.includes("rlm_query") && tree.includes("llm_query"), tree.replace(/\n/g, " | ").slice(0, 80));
}

async function testUnawaitedCostReported(): Promise<void> {
  const background = new BackgroundTasks({});
  const emitter = background.invocation.emitter;
  check("BackgroundTasks starts with nothing pending", background.pending === 0, `${background.pending}`);

  let finish: () => void = () => {};
  const blocked = new Promise<void>((r) => { finish = r; });
  const id = emitter.emitSubcallCreated({ kind: "llm", label: "llm_query", depth: 0 });
  const tracked = background.track(async () => {
    await blocked;
    emitter.emitSubcallUpdated({ id, status: "done", costUsd: 0.05, tokens: 500 });
    return "done";
  });
  check("in-flight detached work is counted", background.pending === 1, `${background.pending}`);
  check("a turn ending mid-flight adopts nothing yet", background.drain().subcalls.length === 0, "");

  finish();
  await tracked;
  // Nobody awaited the Task; the next turn's drain must still report its cost.
  const drained = background.drain();
  check("un-awaited detached cost is still reported at the next drain",
    drained.subcalls.length === 1 && Math.abs(drained.totals.costUsd - 0.05) < 1e-9,
    `${drained.subcalls.length} subcall(s), $${drained.totals.costUsd}`);
  check("pending returns to zero", background.pending === 0, `${background.pending}`);
  background.dispose();
}

// ── 12. Sandbox death with detached work in flight ───────────────────────────────────────

async function testSandboxDeathWithDetached(): Promise<void> {
  const sb = await PythonSandbox.spawn({
    depth: 1,
    handlers: { rlmQuery: async () => { await sleep(50); return "orphan"; } },
  });
  await sb.exec(`t = spawn(rlm_query, "x")`);
  await sb.dispose();
  // Documented behaviour: the reply can never be delivered, and the disposed sandbox
  // rejects rather than hanging a later await_task.
  let rejected = false;
  try {
    await sb.exec(`print(await_task(t))`);
  } catch {
    rejected = true;
  }
  check("a disposed sandbox rejects instead of hanging on an orphaned task", rejected, "");
}

// ── 13. Watchdog heartbeat ───────────────────────────────────────────────────────────────

async function testWatchdogHeartbeat(): Promise<void> {
  // No heartbeat: a request with no incoming frames is killed at requestTimeoutMs.
  const doomed = await PythonSandbox.spawn({
    depth: 1,
    requestTimeoutMs: 1_500,
    handlers: { llmQuery: async () => { await sleep(4_000); return "slow"; } },
  });
  let killed = false;
  try {
    await doomed.exec(`print(await_task(llm_query("x")))`);
  } catch {
    killed = true;
  }
  check("without a heartbeat the request watchdog kills a silent sandbox", killed, "");

  // With a heartbeat the same run survives — this is what index.ts does while
  // background.pending > 0, and it is refreshWatchdog()'s only caller.
  const kept = await PythonSandbox.spawn({
    depth: 1,
    requestTimeoutMs: 1_500,
    handlers: { llmQuery: async () => { await sleep(4_000); return "slow"; } },
  });
  const beat = setInterval(() => kept.refreshWatchdog(), 400);
  try {
    const res = await kept.exec(`print(await_task(llm_query("x")))`);
    check("the heartbeat keeps a healthy long-running sandbox alive",
      res.stdout.trim() === "slow", res.stdout.trim());
  } catch (e) {
    check("the heartbeat keeps a healthy long-running sandbox alive", false, String(e).slice(0, 120));
  } finally {
    clearInterval(beat);
    await kept.dispose();
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────────────────

function testPrompts(): void {
  const headless = buildRlmSystemPrompt({ contextType: "list", contextChars: 100 }, { recursion: true });
  check("headless prompt documents spawn", headless.includes("spawn(fn, *args)"), "");
  check("headless prompt documents await_task", headless.includes("await_task"), "");
  check("native prompt documents spawn", NATIVE_PROMPT_STATIC.includes("spawn(fn, *args)"), "");
  check("native prompt stays within its budget",
    NATIVE_PROMPT_STATIC.length < NATIVE_PROMPT_BUDGET,
    `${NATIVE_PROMPT_STATIC.length.toLocaleString()} / ${NATIVE_PROMPT_BUDGET.toLocaleString()} chars`);

  const hinted = buildReplResultText("out", undefined, [], 3);
  check("repl() result warns about still-running background tasks",
    hinted.text.includes("3 background task(s) still running"), "");
  const quiet = buildReplResultText("out", undefined, [], 0);
  check("no hint when nothing is pending", !quiet.text.includes("background task"), "");
}

async function main(): Promise<void> {
  await testOverlapAndOrder();
  await testCrossTurn();
  await testChunkedConcurrency();
  await testGates();
  testBackgroundRegistry();
  await testUnawaitedCostReported();
  await testSandboxDeathWithDetached();
  await testWatchdogHeartbeat();
  testPrompts();

  const failures = failureCount();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
