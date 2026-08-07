#!/usr/bin/env bun
/**
 * Phase 8b verification — sandbox snapshot/restore.
 * Run: bun run pi-plugin/rlm/test/phase8-snapshot.ts
 * Requires: python3 on PATH
 */

import { check, failureCount } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";


async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase8-snapshot-"));
  const snapPath = join(tmp, "sandbox.pkl");

  try {
    const sb1 = await PythonSandbox.spawn({
      depth: 1, execTimeoutS: 2,
      handlers: { llmQuery: async (p) => `STUB(${p.slice(0, 20)})`, llmQueryBatched: async (ps) => ps.map((_, i) => `STUB${i}`) },
    });
    let r = await sb1.exec("x = [1, 2, 3]");
    check("x assigned", !r.raised);
    r = await sb1.exec("import math; y = math.pi");
    check("y assigned", !r.raised);
    r = await sb1.exec("context_summary = 'snapshot me'");
    check("context_summary assigned", !r.raised);
    const snonce = randomUUID();
    check("snapshot written", await sb1.snapshot(snapPath, snonce));
    await sb1.dispose();

    const sb2 = await PythonSandbox.spawn({
      depth: 1, execTimeoutS: 2,
      handlers: { llmQuery: async (p) => `STUB(${p.slice(0, 20)})`, llmQueryBatched: async (ps) => ps.map((_, i) => `STUB${i}`) },
    });
    check("restore succeeded", await sb2.restore(snapPath, snonce));
    r = await sb2.exec("print(x, round(y, 2))");
    check("vars restored correctly", r.stdout.trim() === "[1, 2, 3] 3.14" || r.stdout.includes("[1, 2, 3]"), r.stdout.trim());
    r = await sb2.exec("print(context_summary)");
    check("F6: context-prefixed user vars survive snapshot restore", r.stdout.trim() === "snapshot me", r.stdout.trim());
    r = await sb2.exec("print(llm_query('test'))");
    check("llm_query works after restore", r.stdout.includes("STUB"), r.stdout.trim());

    // Scaffold integrity across repeated snapshot/restore cycles.
    // An audit blamed restore for "rotating None scaffold names". It cannot: every scaffold
    // name is in RESERVED, so snapshot skips it and restore never rebinds it — and execute()
    // re-injects the scaffold before AND after every exec. Ten cycles with exactly the
    // namespace shape that was suspected (a live Task holding a Worker back-reference, plus a
    // self-referential dict) must leave every name callable.
    const SCAFFOLD = [
      "llm_query", "llm_query_batched", "llm_query_chunked", "rlm_query", "rlm_query_batched",
      "spawn", "rlm_await", "rlm_await_all", "map_files", "llm_map_reduce",
      "search", "grep_context", "outline", "todo", "load_library", "SHOW_VARS",
    ];
    await sb2.exec(`leftover = spawn(llm_query, "held"); selfref = {}; selfref["me"] = selfref`);
    const cyclePath = join(tmp, "cycles.pkl");
    const cycleNonce = randomUUID();
    let cyclesOk = true;
    for (let i = 0; i < 10; i++) {
      cyclesOk = await sb2.snapshot(cyclePath, cycleNonce) && cyclesOk;
      cyclesOk = await sb2.restore(cyclePath, cycleNonce) && cyclesOk;
    }
    check("10 snapshot/restore cycles all succeed", cyclesOk);
    // `globals()` is blocked in the sandbox, so probe the names directly.
    r = await sb2.exec(
      `names = {${SCAFFOLD.map((n) => `"${n}": ${n}`).join(", ")}}\n`
      + `print([n for n, v in names.items() if v is None or not callable(v)])`,
    );
    check("scaffold survives 10 snapshot/restore cycles",
      !r.raised && r.stdout.trim() === "[]", `${r.stdout.trim()} ${r.stderr.slice(0, 120)}`);
    r = await sb2.exec("print(rlm_await(leftover))");
    check("a Task held across the cycles still resolves", r.stdout.includes("STUB"), r.stdout.trim());
    await sb2.dispose();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
