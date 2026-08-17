/**
 * BUG-1 regression proof: a literal `rlm_query("…")` / `rlm_batch([...])` inside a
 * native `repl()` cell must RUN a real child engine — never silently self-echo.
 * Before the fix, repl-tool pushed the cell's own task strings onto the ledger's
 * ancestor stack BEFORE exec, so every direct spawn matched itself and returned
 * ECHO_STUB (done:true, cost 0, indistinguishable from real work).
 *
 * E2E over a REAL Python sandbox with the REAL subcall handler chain
 * (createSubcallHandlers + TaskLedger), a counting runChild, and C3 preserved
 * (echo against a RUNNING ancestor still works, observably).
 * Run: bun run pi-plugin/rlm/test/phase-native-ledger.ts
 */

import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { createSubcallHandlers } from "../src/bridge/handlers/index.ts";
import type { Invocation, SubcallHandlerDeps } from "../src/bridge/handlers/types.ts";
import { ECHO_STUB, TaskLedger } from "../src/core/ledger.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import type { RlmResult } from "../src/core/types.ts";

const CHILD_ANSWER = "GROUNDED";

async function main(): Promise<void> {
  const ledger = new TaskLedger();
  let childRuns = 0;
  const emitter = new RlmEmitter();

  const inv: Invocation = {
    emitter,
    parentId: undefined,
    depth: 0,
    limits: {
      remainingTimeoutMs: () => undefined,
      addUsage: () => {},
      addRaw: () => {},
    },
  };
  const deps: SubcallHandlerDeps = {
    resolve: () => inv,
    gates: createSubcallGates(4, 2),
    registry: MOCK_REGISTRY,
    getLlmModel: () => MOCK_MODEL,
    getConfig: () => ({ maxPromptChars: 100_000, maxDepth: 4, enableLedger: true, rlmBudget: 8 }),
    getModel: () => MOCK_MODEL,
    runChild: async (_input): Promise<RlmResult> => {
      childRuns++;
      return {
        answer: CHILD_ANSWER,
        iterations: 1,
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 5,
      };
    },
    ledger,
  };
  const subcallHandlers = createSubcallHandlers(deps);

  const sb = await PythonSandbox.spawn({
    depth: 0,
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    handlers: { ...subcallHandlers, ledgerClaims: async () => ledger.listClaims() },
  });

  try {
    // ── 1. THE BUG: literal rlm_query from a cell must RUN ─────────────────────
    const r1 = await sb.exec(
      `t = rlm_query("Reply with exactly: GROUNDED. Nothing else.")\nprint("OUT:" + str(await_task(t)))`,
    );
    check(
      "BUG-1 E2E: literal rlm_query from a native cell RUNS (child answer, no echo stub)",
      !r1.raised && r1.stdout.includes("OUT:" + CHILD_ANSWER) && !r1.stdout.includes("ancestor echo"),
      r1.raised ? r1.stderr.trim().slice(0, 80) : r1.stdout.trim().slice(0, 80),
    );
    check("BUG-1 E2E: exactly one child engine spawned", childRuns === 1, `childRuns=${childRuns}`);

    // ── 2. Exact duplicate re-spawn coalesces onto the finished claim ─────────
    const r2 = await sb.exec(
      `t2 = rlm_query("Reply with exactly: GROUNDED. Nothing else.")\nprint("OUT2:" + str(await_task(t2)))`,
    );
    check(
      "BUG-1 E2E: identical re-spawn coalesces (stored answer, no second engine)",
      !r2.raised && r2.stdout.includes("OUT2:" + CHILD_ANSWER) && childRuns === 1,
      `childRuns=${childRuns} ${r2.stdout.trim().slice(0, 60)}`,
    );

    // ── 3. Literal rlm_batch fan-out from a cell runs every task ──────────────
    const r3 = await sb.exec(
      `tb = rlm_batch(["study the alpha module symbols", "study the beta module symbols"])\nres = await_task(tb)\nprint("N=" + str(len(res)))`,
    );
    check(
      "BUG-1 E2E: literal rlm_batch from a native cell runs BOTH tasks",
      !r3.raised && r3.stdout.includes("N=2") && childRuns === 3,
      `childRuns=${childRuns} ${r3.stdout.trim().slice(0, 60)}`,
    );

    // ── 4. C3 preserved: echo against a RUNNING ancestor ──────────────────────
    const ancestor = "study the flaky retry integration end to end";
    ledger.beginRun(ancestor);
    const r4 = await sb.exec(
      `t4 = rlm_query("study the flaky retry integration end to end")\nprint("OUT4:" + str(await_task(t4)))`,
    );
    ledger.endRun();
    check(
      "BUG-1 E2E: restating a RUNNING ancestor still echoes (C3 preserved)",
      r4.stdout.includes("ancestor echo rejected") && childRuns === 3,
      `childRuns=${childRuns} ${r4.stdout.trim().slice(0, 80)}`,
    );

    // ── 5. Observability: suppressed spawns are countable from the session ────
    const r5 = await sb.exec("print(list_claims())");
    check(
      "BUG-1 E2E: list_claims surfaces echo_rejected",
      r5.stdout.includes("echo_rejected="),
      r5.stdout.trim().slice(0, 80),
    );
    check(
      "BUG-1: ECHO_STUB is the actionable v5 message",
      ECHO_STUB.includes("already doing this task") && !ECHO_STUB.includes("await the existing task"),
      ECHO_STUB.slice(0, 60),
    );
  } finally {
    await sb.dispose();
  }
}

await main();
process.exit(failureCount() > 0 ? 1 : 0);
