/**
 * Stdout-budget fairness — per-print verbatim budget + per-block middle-collapse
 * (core/answer.ts) and the worker's print-boundary marks / out-of-band nudges
 * (sandbox/py/worker.py). Regression pin: a targeted print after a bulk print must
 * pass through verbatim (the read-loop incident).
 * Run: bun run pi-plugin/rlm/test/phase-stdout-budget.ts
 */

import { check, finish, runSuite } from "./helpers.ts";
import { formatReplOutputs } from "../src/core/answer.ts";
import type { ReplResult } from "../src/sandbox/protocol.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

/** Literal ReplResult with the fields formatting tests vary (marks/nudges) defaulted clean. */
function result(stdout: string, stdoutMarks: readonly number[] = [], nudges: readonly string[] = []): ReplResult {
  return {
    stdout, stderr: "", finalAnswer: null, answerContent: "", raised: false,
    executionTimeMs: 0, varNames: [], stdoutMarks, nudges, pendingTasks: [],
  };
}

async function main() {
  // ── 1. Legacy no-marks: an old worker (or sys.stdout.write-only output) degrades to one
  // segment — still elided, at the same per-print budget.
  {
    const legacy = formatReplOutputs([result("a".repeat(5_000), [])]);
    check("legacy single segment is elided", legacy.includes("chars elided"), legacy.slice(0, 80));
    check("legacy output bounded near the verbatim cap", legacy.length < 4_400, String(legacy.length));
    check("legacy dump does not pass through whole", !legacy.includes("a".repeat(5_000)), "");
  }

  // ── 2. THE incident: a targeted print after a 5K bulk print survives verbatim.
  {
    const out = formatReplOutputs([result("a".repeat(5_000) + "\nTAIL_MARKER", [5_001])]);
    check("targeted print after a bulk print passes through", out.includes("TAIL_MARKER"), out.slice(-120));
    check("bulk print carries the per-print elision mark", out.includes("per-print stdout cap 4,000"), out.slice(0, 140));
    check("bulk print still does not pass through whole", !out.includes("a".repeat(5_000)), "");
  }

  // ── 3. Boundary: a print under the cap passes through whole; an end-of-stdout mark
  // (offset == trimmed length) is dropped, not turned into an empty segment.
  {
    const edge = "x".repeat(3_999);
    check("3,999-char print passes verbatim", formatReplOutputs([result(edge)]) === `REPL stdout:\n${edge}`, "");
    check("mark at stdout end is dropped", formatReplOutputs([result(edge, [3_999])]) === `REPL stdout:\n${edge}`, "");
  }

  // ── 4. Per-block budget: six 5K prints exceed 4×4,000 — first and last survive, the
  // middle run collapses to one bulk note.
  {
    const stdout = "abcdef".split("").map((c) => c.repeat(5_000)).join("\n");
    const marks = [5_001, 10_002, 15_003, 20_004, 25_005];
    const big = formatReplOutputs([result(stdout, marks)]);
    check("first print keeps its head", big.includes("a".repeat(2_800)), "");
    check("second print survives too (head half-budget)", big.includes("b".repeat(2_800)), "");
    check("middle prints are collapsed", !big.includes("c".repeat(1_000)) && !big.includes("d".repeat(1_000)) && !big.includes("e".repeat(1_000)), "");
    check("last print keeps its tail", big.includes("f".repeat(1_200)), "");
    check("bulk note names the collapsed count + per-block cap",
      big.includes("3 middle print output(s) elided") && big.includes("per-block stdout cap 16,000"), "");
    check("collapsed output stays under the per-block budget", big.length <= 16_600, String(big.length));
  }

  // ── 5. Config knob flows into the marker (settings → engine → answer.ts).
  {
    const tight = formatReplOutputs([result("y".repeat(1_200))], 0, { verbatimChars: 800 });
    check("verbatimChars option drives the marker number", tight.includes("per-print stdout cap 800"), tight.slice(0, 140));
  }

  // ── 6. Integration: the real worker emits one mark per print, keeps nudges out of stdout.
  {
    const sb = await PythonSandbox.spawn({ depth: 1 });
    const r1 = await sb.exec("print('x'*5000)\nprint('TAIL_MARKER')");
    check("worker emits one mark per print", r1.stdoutMarks.length === 2, JSON.stringify(r1.stdoutMarks));
    check("no nudges without huge vars", r1.nudges.length === 0, JSON.stringify(r1.nudges));
    const fair = formatReplOutputs([r1]);
    check("incident pin: real sandbox — print after bulk print survives", fair.includes("TAIL_MARKER"), fair.slice(-120));
    check("incident pin: bulk print collapsed at the per-print cap", fair.includes("per-print stdout cap 4,000"), fair.slice(0, 140));

    const r2 = await sb.exec('big = "a" * 600_000\nprint(len(big))');
    check("huge-var nudge rides the nudges field",
      r2.nudges.length === 1 && r2.nudges[0]?.includes("big (600,000 chars)"), JSON.stringify(r2.nudges));
    check("nudge no longer pollutes stdout", !r2.stdout.includes("huge raw-text"), r2.stdout.slice(0, 60));
    await sb.dispose();
  }

  finish();
}

runSuite(main);
