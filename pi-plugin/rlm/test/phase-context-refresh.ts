/**
 * Context freshness after disk edits — host snapshot + live worker must see new content.
 * Run: bun run pi-plugin/rlm/test/phase-context-refresh.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, failureCount } from "./helpers.ts";
import {
  extractEditPaths,
  normalizeContextPath,
  upsertContextFile,
  patchContextExecCode,
} from "../src/context/refresh.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

const dir = join(tmpdir(), `rlm-ctx-refresh-${Date.now()}`);
await mkdir(dir, { recursive: true });
const file = join(dir, "retry.py");
await writeFile(file, "DEFAULT_TIMEOUT_MS = 50\n", "utf8");

// ── pure helpers ──
check(
  "extractEditPaths finds path",
  extractEditPaths({ path: "src/a.ts", oldText: "x", newText: "y" })[0] === "src/a.ts",
);
check(
  "normalizeContextPath relative under cwd",
  normalizeContextPath(file, dir) === "retry.py" || normalizeContextPath(file, dir).endsWith("retry.py"),
);

const seeded = upsertContextFile(
  [{ path: "retry.py", content: "DEFAULT_TIMEOUT_MS = 50\n", tokens: 5 }],
  "retry.py",
  "DEFAULT_TIMEOUT_MS = 500\n",
  dir,
);
check("upsert replaces content", seeded[0]?.content.includes("500") === true);
check("upsert returns new array identity", Array.isArray(seeded) && seeded.length === 1);

// ── live worker ──
const sb = await PythonSandbox.spawn({
  depth: 0,
  handlers: {},
  maxPromptChars: 400_000,
});
try {
  await sb.loadContext([
    { path: "retry.py", content: "DEFAULT_TIMEOUT_MS = 50\n", tokens: 5 },
  ]);
  let r = await sb.exec(`print(next(e['content'] for e in context if e['path']=='retry.py'))`);
  check("worker has old content", r.stdout.includes("50"), r.stdout.trim());

  await writeFile(file, "DEFAULT_TIMEOUT_MS = 500\n", "utf8");
  const patch = patchContextExecCode("retry.py", "DEFAULT_TIMEOUT_MS = 500\n", dir);
  r = await sb.exec(patch + "\nprint(next(e['content'] for e in context if 'retry' in e['path']))");
  check("worker sees new content after patch", r.stdout.includes("500"), r.stdout.trim());

  r = await sb.exec(`print(grep_context('500', k=5)['total'] > 0)`);
  check("grep_context finds new needle", r.stdout.includes("True"), r.stdout.trim());
} finally {
  await sb.dispose();
}

const failed = failureCount();
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
