/**
 * Aggregate smoke harness — port of codex-bais `scripts/smoke-test.js`.
 * Boots the REAL Python sandbox, asserts the edit surface is gone, then runs
 * every phase suite as a child process and folds their exit codes into one.
 * Run: bun run pi-plugin/rlm/test/smoke.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

const WATCHDOG_MS = 180_000;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Suites run in sequence as child processes. */
const SUITES: readonly string[] = Object.freeze([
  "phase1.ts", "phase2.ts", "phase3.ts", "phase3-render.ts", "phase4.ts",
  "phase6.ts", "phase8-state.ts", "phase8-snapshot.ts", "phase8-resume.ts",
  "phase9-prune.ts", "phase9-engine-persistence.ts", "phase-chunked.ts",
  "phase-async.ts", "phase-gates.ts", "phase-guards.ts", "phase-library.ts", "phase-pipeline.ts",
  "phase-state.ts", "native-mode.ts", "native-smoke.ts",
]);

async function assertEditSurfaceRemoved(): Promise<void> {
  const sandbox = await PythonSandbox.spawn({
    depth: 0, execTimeoutS: 30, requestTimeoutMs: 30_000,
    python: "python3", initTimeoutMs: 30_000, maxPromptChars: 400_000,
    handlers: {},
  });
  try {
    const gone = await sandbox.exec("print(stage_edit)");
    check("smoke — stage_edit is removed from the sandbox", gone.raised && gone.stderr.includes("NameError"));
    const alive = await sandbox.exec("print(callable(llm_query), callable(SHOW_VARS), callable(load_library))");
    check("smoke — core REPL surface intact", !alive.raised && alive.stdout.includes("True True True"));
  } finally {
    await sandbox.dispose();
  }

  // Read-only open guard (pipeline mode) — all common write routes blocked.
  const ro = await PythonSandbox.spawn({
    depth: 0, execTimeoutS: 30, requestTimeoutMs: 30_000,
    python: "python3", initTimeoutMs: 30_000, maxPromptChars: 400_000,
    readOnly: true, handlers: {},
  });
  try {
    for (const [label, code] of Object.freeze([
      ["builtin open", `open("probe-a.txt","w").write("x")`],
      ["pathlib", `from pathlib import Path\nPath("probe-b.txt").write_text("x")`],
      ["os.open", `import os\nos.open("probe-c.txt", os.O_WRONLY | os.O_CREAT)`],
    ] as const)) {
      const r = await ro.exec(code);
      check(
        `smoke — read-only blocks ${label}`,
        r.raised && r.stderr.includes("PermissionError"),
        r.stderr.slice(0, 160),
      );
    }
    const readOk = await ro.exec(`print(open("/dev/null").read() or "ok")`);
    check("smoke — read-only run still allows reading", !readOk.raised && readOk.stdout.includes("ok"), readOk.stderr.slice(0, 120));
  } finally {
    await ro.dispose();
  }
}

let activeChild: ChildProcess | undefined;

function runSuite(name: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", join(TEST_DIR, name)], {
      stdio: "inherit",
      cwd: join(TEST_DIR, ".."),
    });
    activeChild = child;
    child.on("error", (err) => {
      console.error(`smoke — failed to spawn ${name}:`, err);
      if (activeChild === child) activeChild = undefined;
      resolve(1);
    });
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      resolve(code ?? 1);
    });
  });
}

const watchdog = setTimeout(() => {
  console.error(`smoke test timed out after ${WATCHDOG_MS}ms`);
  activeChild?.kill("SIGKILL");
  process.exit(1);
}, WATCHDOG_MS);

try {
  await assertEditSurfaceRemoved();
  let suiteFails = 0;
  for (let i = 0; i < SUITES.length; i++) {
    const name = SUITES[i];
    console.log(`\n── smoke suite: ${name} ──`);
    const code = await runSuite(name);
    if (code !== 0) {
      suiteFails++;
      console.error(`smoke — suite ${name} exited ${code}`);
    }
  }
  clearTimeout(watchdog);
  const harnessFails = failureCount();
  const total = harnessFails + suiteFails;
  console.log(total === 0 ? "\nsmoke: all suites passed" : `\nsmoke: ${total} failure(s) (${suiteFails} suite(s), ${harnessFails} harness)`);
  process.exit(total === 0 ? 0 : 1);
} catch (err: unknown) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  clearTimeout(watchdog);
  activeChild?.kill("SIGKILL");
  process.exit(1);
}
