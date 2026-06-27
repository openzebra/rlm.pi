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
    r = await sb2.exec("print(llm_query('test'))");
    check("llm_query works after restore", r.stdout.includes("STUB"), r.stdout.trim());
    await sb2.dispose();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
