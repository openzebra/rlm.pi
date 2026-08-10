/**
 * Worker-lifecycle regression tests.
 * Run: bun run pi-plugin/rlm/test/worker-lifecycle.ts
 *
 * Covers three upstream worker bugs:
 *   ① idle exit — a worker whose parent stops answering (crash / migration) must
 *     exit instead of lingering forever on a blocking readline();
 *   ②A dispose-on-loadContext-failure — a sandbox spawned but failing context load
 *     must be disposed, not leaked;
 *   ②B dispose racing spawn — disposing a SandboxManager mid-spawn must abort the
 *     child and leave nothing behind.
 */

import { once } from "node:events";
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(TEST_DIR, "..", "src", "sandbox", "py", "worker.py");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Count live `worker.py` processes (the `[w]` trick excludes the grep itself). */
function countWorkerProcs(): number {
  try {
    const out = execSync("ps -eo command | grep -c '[w]orker.py' || true", { stdio: ["ignore", "pipe", "ignore"] });
    return Number.parseInt(out.toString().trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function spawnRawWorker(idleTimeoutS: number) {
  return spawn("python3", [WORKER_PATH, "--depth", "1", "--idle-timeout", String(idleTimeoutS)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Read the next JSONL line from a stream. */
function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stream });
    rl.once("line", (line) => { rl.close(); resolve(line); });
  });
}

// ── Bug ①: idle exit ──

async function testIdleExitWhenParentSilent() {
  // A parent that never answers the ping (crashed / migrated) must not pin the worker.
  const worker = spawnRawWorker(1);
  await nextLine(worker.stdout); // {"id":"_init","ok":true}
  // Do NOT answer the ping. Worker should exit ~idle(1s) + pong-wait(5s) after _init.
  const exited = await Promise.race([
    once(worker, "exit").then(() => true),
    sleep(20_000).then(() => { worker.kill("SIGKILL"); return false; }),
  ]);
  check("① idle exit — worker exits when parent stays silent", exited);
}

async function testIdleKeepsAliveWhenParentAnswers() {
  // A live parent answers pongs, so the worker stays up across idle windows.
  const worker = spawnRawWorker(1);
  const rl = createInterface({ input: worker.stdout });
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as { type?: string };
      if (msg.type === "ping") worker.stdin.write('{"type":"pong"}\n');
    } catch { /* non-JSON breadcrumb, ignore */ }
  });
  await nextLine(worker.stdout); // _init
  await sleep(3_000); // longer than the 1s idle window + ping cadence
  const alive = worker.exitCode === null && worker.signalCode === null;
  check("① idle keep-alive — worker stays alive while parent answers pongs", alive);
  worker.stdin.write('{"id":"s","type":"shutdown"}\n');
  await once(worker, "exit").catch(() => {});
  rl.close();
}

// ── Bug ②A: loadContext failure must dispose the spawned sandbox ──

async function testLoadContextFailureDisposes() {
  // Unit-level: stub PythonSandbox.spawn so the spawn succeeds but loadContext throws;
  // the manager must dispose the child. (A real worker's load_context is fast and reliable,
  // so an integration version would need a brittle watchdog race to trigger the failure.)
  const realSpawn = PythonSandbox.spawn;
  let disposed = false;
  const fakeSandbox = {
    dispose: async () => { disposed = true; },
    loadContext: async () => { throw new Error("context load failed"); },
  } as unknown as PythonSandbox;
  PythonSandbox.spawn = async () => fakeSandbox;
  try {
    const mgr = new SandboxManager({
      execTimeoutS: 30,
      requestTimeoutMs: 10_000,
      python: "python3",
      sandboxInitTimeoutMs: 30_000,
      maxPromptChars: 400_000,
      awaitTimeoutS: 10,
    });
    mgr.contextPayload = [{ path: "x.ts", content: "x", tokens: 1 }];
    let rejected = false;
    try {
      await mgr.getOrCreate({});
    } catch {
      rejected = true;
    }
    check("②A — getOrCreate rejects when loadContext fails", rejected);
    check("②A — spawned sandbox is disposed on loadContext failure", disposed);
    check("②A — manager holds no sandbox after failure", !mgr.isAlive);
    await mgr.dispose();
  } finally {
    PythonSandbox.spawn = realSpawn;
  }
}

// ── Bug ②B: dispose racing spawn must leave nothing behind ──

async function testDisposeRacingSpawn() {
  // Deterministic unit check: a spawn that resolves AFTER dispose must not attach
  // the sandbox to the manager (the .then guard disposes it instead). Stub spawn
  // with an already-resolved promise so the guard is the only thing between the
  // resolved child and the disposed manager.
  const realSpawn = PythonSandbox.spawn;
  let disposed = false;
  const fakeSandbox = {
    dispose: async () => { disposed = true; },
    // Successful loadContext — so the ②A catch path is NOT what disposes the child
    // here; only the ②B disposed guard can. Without it the sandbox attaches to the
    // manager and this test fails (manager holds a sandbox after dispose).
    loadContext: async () => 0,
  } as unknown as PythonSandbox;
  PythonSandbox.spawn = async () => fakeSandbox;
  try {
    const mgr = new SandboxManager({
      execTimeoutS: 30,
      requestTimeoutMs: 10_000,
      python: "python3",
      sandboxInitTimeoutMs: 30_000,
      maxPromptChars: 400_000,
      awaitTimeoutS: 10,
    });
    const spawning = mgr.getOrCreate({});
    await mgr.dispose();
    await spawning.catch(() => {});
    check("②B — manager holds no sandbox when dispose wins the race", !mgr.isAlive);
    check("②B — racing child is disposed, not leaked", disposed);
  } finally {
    PythonSandbox.spawn = realSpawn;
  }

  // Integration: real spawn + immediate dispose — abort SIGKILLs the child and no
  // worker process outlives the manager.
  const before = countWorkerProcs();
  const mgr2 = new SandboxManager({
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    sandboxInitTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    awaitTimeoutS: 10,
  });
  const spawning2 = mgr2.getOrCreate({});
  await mgr2.dispose();
  await spawning2.catch(() => {});
  await sleep(500);
  check("②B — integration: no worker process after racing dispose",
    countWorkerProcs() <= before, `before=${before}`);
}

// ── Main ──

async function main() {
  console.log("─── worker-lifecycle ───");
  await testIdleExitWhenParentSilent();
  await testIdleKeepsAliveWhenParentAnswers();
  await testLoadContextFailureDisposes();
  await testDisposeRacingSpawn();

  console.log(`\n${failureCount() === 0 ? "✓ All tests passed" : `✗ ${failureCount()} failure(s)`}`);
  process.exit(failureCount() > 0 ? 1 : 0);
}

await main();
