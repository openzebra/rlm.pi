#!/usr/bin/env bun
/**
 * Phase 3 unified diff approval/application verification — token-free.
 * Run: bun run pi-plugin/rlm/test/diff-approval.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { handleDiffEditRequest } from "../src/core/engine.ts";
import { RlmController } from "../src/mode/rlm-mode.ts";
import { applyProposedDiffs, prepareDiffApplication } from "../src/commands/rlm.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-diff-approval-"));
  const config = { ...DEFAULT_CONFIG, editEnabled: true };
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+BETA
`;
  const multi = `${diff}diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+created
`;

  try {
    writeFileSync(join(tmp, "a.txt"), "alpha\nbeta\n", "utf8");

    let approvalCalls = 0;
    const declined = await handleDiffEditRequest(tmp, diff, [], config, async (request) => {
      approvalCalls++;
      check("approval request includes unified diff", request.diff === diff);
      check("approval request includes validation preview", request.validationPreview.includes("unified diff validated"), request.validationPreview);
      return false;
    });
    check("valid diff is declined without approval", declined.includes("declined"), declined);
    check("approval callback called once for valid diff", approvalCalls === 1, String(approvalCalls));

    approvalCalls = 0;
    const approved = await handleDiffEditRequest(tmp, diff, [], config, async () => { approvalCalls++; return true; });
    check("approved valid diff records ok preview", approved.startsWith("ok — unified diff validated"), approved);
    check("approval callback called for approved diff", approvalCalls === 1, String(approvalCalls));

    approvalCalls = 0;
    const malformed = await handleDiffEditRequest(tmp, "not a diff", [], config, async () => { approvalCalls++; return true; });
    check("malformed diff rejects before approval", malformed.startsWith("Error:"), malformed);
    check("malformed diff does not prompt", approvalCalls === 0, String(approvalCalls));

    const duplicate = await handleDiffEditRequest(tmp, diff, [{ diff }], config, async () => { approvalCalls++; return true; });
    check("duplicate diff bypasses re-approval", duplicate.includes("duplicate diff"), duplicate);

    const prepared = await prepareDiffApplication(tmp, multi, DEFAULT_CONFIG.fsLimits.maxReadBytes);
    check("prepareDiffApplication validates multi-file diff", prepared.ok && prepared.files.length === 2, prepared.ok ? String(prepared.files.length) : prepared.error);

    const confirms: string[] = [];
    const notifications: string[] = [];
    const ctx = {
      cwd: tmp,
      hasUI: true,
      ui: {
        confirm: async (_title: string, body: string) => { confirms.push(body); return true; },
        notify: (message: string) => { notifications.push(message); },
      },
    } as unknown as ExtensionContext;
    const controller = new RlmController(config);
    await applyProposedDiffs(controller, ctx, [{ diff: multi }]);
    check("final apply asks with unified diff summary", confirms.length === 1 && confirms[0]!.includes("Files: 2"), confirms[0] ?? "missing");
    check("final apply updates existing file", readFileSync(join(tmp, "a.txt"), "utf8") === "alpha\nBETA\n");
    check("final apply creates new file", readFileSync(join(tmp, "new.txt"), "utf8") === "created\n");
    check("final apply notifies success", notifications.some((item) => item.includes("Applied 3 RLM diff change")), notifications.join(" | "));

    const deleteDiff = `diff --git a/new.txt b/new.txt
deleted file mode 100644
--- a/new.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-created
`;
    await applyProposedDiffs(controller, ctx, [{ diff: deleteDiff }]);
    check("final apply deletes files", !existsSync(join(tmp, "new.txt")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("FATAL", err); process.exit(1); });
