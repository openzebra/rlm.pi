/**
 * Scaffold signature regression suite.
 *
 * Issue: the native-mode docs advertise `rlm_query(task=…)` / `rlm_batch(tasks=[…])` while the
 * Python scaffold only accepted `prompt` / `prompts` — so every documented call raised
 * TypeError and the assignment never ran, poisoning later cells with NameError.
 *
 * This suite locks in: both spellings accepted, positional form accepted, bad calls raise a
 * self-describing TypeError, `paths` reaches the host handler, and the docs never again
 * advertise a kwarg the worker doesn't accept (doc-drift guard).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import type { SubcallOpts } from "../src/sandbox/interrupts.ts";
import { check, failureCount } from "./helpers.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Records what the host handlers were called with, so kwarg plumbing is verified end-to-end. */
interface CallRecord {
  readonly kind: "rlm_query" | "rlm_batch";
  readonly payload: string;
  readonly paths: readonly string[] | undefined;
}

const calls: CallRecord[] = [];

async function main(): Promise<void> {
  const sb = await PythonSandbox.spawn({
    depth: 0,
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    handlers: {
      llmQuery: async (prompt: string) => `leaf:${String(prompt)}`,
      llmBatch: async (prompts: readonly string[]) => prompts.map((p) => `leaf:${p}`),
      rlmQuery: async (task: string, _depth: number, opts: SubcallOpts) => {
        calls.push({ kind: "rlm_query", payload: task, paths: opts.paths });
        return `child:${task}`;
      },
      rlmBatch: async (tasks: readonly string[], _depth: number, opts: SubcallOpts) => {
        calls.push({ kind: "rlm_batch", payload: tasks.join("|"), paths: opts.paths });
        return tasks.map((t) => `child:${t}`);
      },
    },
  });

  try {
    // ── rlm_query: documented spelling, legacy spelling, positional ─────────────────────
    const r1 = await sb.exec(`
t = rlm_query(task="study A", paths=["src/"])
a = await_task(t)
print("Q1", a)
`);
    check(
      "rlm_query(task=…) spawns, awaits, and returns the child report",
      !r1.raised && r1.stdout.includes("Q1 child:study A"),
    );

    const r2 = await sb.exec(`
t2 = rlm_query(prompt="study B")
print("Q2", await_task(t2))
`);
    check("rlm_query(prompt=…) legacy spelling still works", !r2.raised && r2.stdout.includes("Q2 child:study B"));

    const r3 = await sb.exec(`
t3 = rlm_query("study C")
print("Q3", await_task(t3))
`);
    check("rlm_query('…') positional still works", !r3.raised && r3.stdout.includes("Q3 child:study C"));

    // ── rlm_batch: documented + legacy spelling ─────────────────────────────────────────
    const r4 = await sb.exec(`
tb = rlm_batch(tasks=["one", "two"])
print("B1", await_task(tb))
`);
    check(
      "rlm_batch(tasks=[…]) returns an ordered list of reports",
      !r4.raised && r4.stdout.includes("B1 ['child:one', 'child:two']"),
    );

    const r5 = await sb.exec(`
tb2 = rlm_batch(prompts=["three"])
print("B2", await_task(tb2))
`);
    check("rlm_batch(prompts=[…]) legacy spelling still works", !r5.raised && r5.stdout.includes("B2 ['child:three']"));

    // ── paths kwarg reaches the host handler ────────────────────────────────────────────
    const qCall = calls.find((c) => c.kind === "rlm_query" && c.payload === "study A");
    check(
      "rlm_query paths= kwarg is forwarded to the host handler",
      qCall !== undefined && qCall.paths !== undefined && qCall.paths[0] === "src/",
    );
    const bCall = calls.find((c) => c.kind === "rlm_batch" && c.payload === "one|two");
    check("rlm_batch handler received every task", bCall !== undefined);

    // ── bad calls raise self-describing TypeErrors (no silent None, no bare crash) ─────
    const e1 = await sb.exec("t_bad = rlm_query()");
    check(
      "rlm_query() with no text raises a TypeError naming the correct call",
      e1.raised && e1.stderr.includes("TypeError") && e1.stderr.includes("rlm_query(task="),
    );

    const e2 = await sb.exec("tb_bad = rlm_batch(tasks=[])\n");
    check(
      "rlm_batch(tasks=[]) raises a TypeError naming the correct call",
      e2.raised && e2.stderr.includes("TypeError") && e2.stderr.includes("rlm_batch(tasks="),
    );

    // ── doc-drift guard: never advertise a kwarg the scaffold doesn't accept ────────────
    testDocDrift();
  } finally {
    await sb.dispose();
  }

  const failures = failureCount();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Advertised rlm_* kwargs in the prompt docs must exist in the worker scaffold's signatures. */
function testDocDrift(): void {
  const srcDir = join(TEST_DIR, "..", "src");
  // Phase 0 (v5 port): the REPL surface moved off worker.py onto the WorkerScaffold mixin in scaffold.py.
  const worker =
    readFileSync(join(srcDir, "sandbox", "py", "worker.py"), "utf8") +
    readFileSync(join(srcDir, "sandbox", "py", "scaffold.py"), "utf8");
  const docs =
    readFileSync(join(srcDir, "prompts", "native.ts"), "utf8") +
    readFileSync(join(srcDir, "prompts", "glossary.ts"), "utf8") +
    readFileSync(join(srcDir, "prompts", "system.ts"), "utf8");

  const advertised = new Set<string>();
  for (const m of docs.matchAll(/\brlm_(?:query|batch)\(\s*(\w+)\s*=/g)) {
    const kw = m[1];
    if (kw !== undefined) advertised.add(kw);
  }

  check("docs advertise at least the canonical kwargs", advertised.has("task") && advertised.has("tasks"));
  for (const kw of advertised) {
    // kwarg advertised in docs → must appear as a parameter of the worker scaffold method
    const inScaffold = new RegExp(`def _rlm_(?:query|batch)\\(self[^)]*\\b${kw}\\b[^)]*\\)`).test(worker);
    check("doc-drift — advertised kwarg " + kw + "= exists in worker.py scaffold", inScaffold);
  }
}

main().catch((e: unknown) => {
  console.error("FATAL", e);
  process.exit(1);
});
