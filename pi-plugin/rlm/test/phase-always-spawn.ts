/**
 * Core tools always return Task (never auto-await). Parallel fire must not serialize.
 * Run: bun run pi-plugin/rlm/test/phase-always-spawn.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let active = 0;
  let peak = 0;
  const sb = await PythonSandbox.spawn({
    depth: 1,
    handlers: {
      llmQuery: async (prompt) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(80);
        active -= 1;
        return `L:${prompt}`;
      },
      llmBatch: async (prompts) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(120);
        active -= 1;
        return prompts.map((p, i) => `B${i}:${p}`);
      },
      rlmQuery: async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(80);
        active -= 1;
        return `R:${task.slice(0, 20)}`;
      },
      rlmBatch: async (tasks) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(120);
        active -= 1;
        return tasks.map((t, i) => `RB${i}:${t.slice(0, 12)}`);
      },
    },
  });

  try {
    let r = await sb.exec(`
t = llm_batch(["a", "b"])
print(type(t).__name__, getattr(t, "done", None))
`);
    check(
      "llm_batch returns Task immediately (not list)",
      r.stdout.includes("Task") && r.stdout.includes("False"),
      r.stdout.trim(),
    );

    r = await sb.exec(`print(type(llm_query("x")).__name__, type(rlm_query("y")).__name__, type(rlm_batch(["z"])).__name__)`);
    check(
      "llm_query / rlm_query / rlm_batch all return Task",
      (r.stdout.match(/Task/g) ?? []).length >= 3,
      r.stdout.trim(),
    );

    peak = 0;
    const started = Date.now();
    r = await sb.exec(`
t1 = llm_batch(["q1", "q2"])
t2 = llm_batch(["q3", "q4"])
t3 = rlm_batch(["study A", "study B"])
# free work while host runs
hits = search("nothing likely")
out = await_task([t1, t2, t3])
print(len(out), type(out[0]).__name__ if out else "empty")
print("done")
`);
    const elapsed = Date.now() - started;
    // Serial would be ~120*2 + 120 = 360ms+; parallel host should finish near one batch (~150-250ms)
    check("parallel fire wall time much less than serial", elapsed < 400, `${elapsed}ms peak=${peak}`);
    check("host had concurrent batches in flight", peak >= 2, `peak=${peak}`);
    check("await_task collected results", r.stdout.includes("done") && !r.raised, r.stdout.trim().slice(0, 120));

    // search/grep dual keys
    await sb.loadContext([
      { path: "a.ts", content: "const SNIP_NEEDLE = 1\n", tokens: 4 },
    ]);
    r = await sb.exec(`
h = search("SNIP_NEEDLE", k=3)
print(sorted(h[0].keys()) if h else "none")
g = grep_context("SNIP_NEEDLE", k=3)
print(sorted(g["hits"][0].keys()) if g["hits"] else "none")
print(h[0]["snippet"][:20] if h else "")
print(g["hits"][0]["snippet"][:20] if g["hits"] else "")
`);
    check(
      "search hit has snippet and text",
      r.stdout.includes("snippet") && r.stdout.includes("'text'"),
      r.stdout.trim(),
    );
    check(
      "grep hit has snippet and text (no KeyError)",
      r.stdout.includes("snippet") && r.stdout.includes("SNIP_NEEDLE") && !r.raised,
      r.stdout.trim(),
    );
  } finally {
    await sb.dispose();
  }

  const failed = failureCount();
  console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
  process.exit(failed ? 1 : 0);
}

await main();
