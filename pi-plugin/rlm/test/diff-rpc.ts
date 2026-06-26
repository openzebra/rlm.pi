#!/usr/bin/env bun
/**
 * Unified diff RPC verification — token-free sandbox/worker smoke test.
 * Run: bun run pi-plugin/rlm/test/diff-rpc.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import type { ProposedDiffEdit } from "../src/sandbox/protocol.ts";
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void { console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`); if (!cond) failures++; }
async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-diff-rpc-"));
  const seen: { diff: string; existing: readonly ProposedDiffEdit[]; depth: number }[] = [];
  try {
    const sandbox = await PythonSandbox.spawn({ depth: 0, execTimeoutS: 5, workspaceRoot: tmp, handlers: { rlmEdit: async (diff, existingDiffs, depth) => { seen.push({ diff, existing: existingDiffs, depth }); return diff.includes("diff --git") ? "ok — diff validated" : "Error: malformed diff"; } } });
    const diff = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const res = await sandbox.exec(`diff = ${JSON.stringify(diff)}\nprint(rlm_edit(diff))\nprint(SHOW_DIFFS())`);
    check("rlm_edit succeeds", !res.raised && res.stdout.includes("ok — diff validated"), res.stderr || res.stdout);
    check("handler receives diff", seen.length === 1 && seen[0]?.diff === diff, String(seen.length));
    check("handler receives depth", seen[0]?.depth === 0, String(seen[0]?.depth));
    check("worker records diff", res.diffs.length === 1 && res.diffs[0]?.diff === diff, JSON.stringify(res.diffs));
    const duplicate = await sandbox.exec("print(rlm_edit(diff))");
    check("duplicate diff does not call handler again", seen.length === 1 && duplicate.stdout.includes("duplicate"), duplicate.stdout);
    const bad = await sandbox.exec("print(rlm_edit('not a diff'))");
    check("malformed diff rejection is surfaced", bad.stdout.includes("Error: malformed diff"), bad.stdout);
    await sandbox.dispose();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error("FATAL", err); process.exit(1); });
