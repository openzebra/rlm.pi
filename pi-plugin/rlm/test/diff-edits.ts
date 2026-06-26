#!/usr/bin/env bun
/**
 * Unified diff edit verification — token-free.
 * Run: bun run pi-plugin/rlm/test/diff-edits.ts
 */

import { applyUnifiedDiffSet, applyUnifiedDiffToText, parseUnifiedDiff, unifiedDiffPaths } from "../src/text/unified-diff.ts";
import { renderUnifiedDiffSummary } from "../src/text/edit-preview.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

const single = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const multi = `${single}diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
 alpha
+beta
 omega
`;

const created = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const value = 1;
+export const name = "new";
`;

const parsed = parseUnifiedDiff(single);
check("parseUnifiedDiff parses one file", parsed.ok && parsed.files.length === 1, parsed.ok ? String(parsed.files.length) : parsed.error);
if (parsed.ok) {
  check("parseUnifiedDiff strips a/b prefixes", parsed.files[0]?.path === "src/a.ts", parsed.files[0]?.path ?? "missing");
  const applied = applyUnifiedDiffToText("one\ntwo\nthree\n", parsed.files[0]!);
  check("applyUnifiedDiffToText replaces a line", applied.ok && applied.text === "one\nTWO\nthree\n", applied.ok ? applied.text : applied.error);
}

const setApplied = applyUnifiedDiffSet(multi, new Map([
  ["src/a.ts", "one\ntwo\nthree\n"],
  ["src/b.ts", "alpha\nomega\n"],
]));
check("applyUnifiedDiffSet applies multiple files", setApplied.ok && setApplied.files.length === 2, setApplied.ok ? String(setApplied.files.length) : setApplied.error);
if (setApplied.ok) {
  check("multi-file result updates second file", setApplied.files[1]?.text === "alpha\nbeta\nomega\n", setApplied.files[1]?.text ?? "missing");
}

const createApplied = applyUnifiedDiffSet(created, new Map());
check("new file diff applies from /dev/null", createApplied.ok && createApplied.files[0]?.text.includes("value = 1"), createApplied.ok ? createApplied.files[0]?.text ?? "" : createApplied.error);

const mismatch = parsed.ok ? applyUnifiedDiffToText("one\nwrong\nthree\n", parsed.files[0]!) : parsed;
check("hunk mismatch is rejected", !mismatch.ok && mismatch.error.includes("hunk mismatch"), mismatch.ok ? mismatch.text : mismatch.error);

const malformed = parseUnifiedDiff("--- a/x\n@@ -1 +1 @@\n-a\n+b\n");
check("malformed diff is rejected", !malformed.ok, malformed.ok ? "unexpected ok" : malformed.error);

check("unifiedDiffPaths returns parsed paths", unifiedDiffPaths(multi).join(",") === "src/a.ts,src/b.ts", unifiedDiffPaths(multi).join(","));
check("renderUnifiedDiffSummary includes file count", renderUnifiedDiffSummary(multi).includes("Files: 2"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
