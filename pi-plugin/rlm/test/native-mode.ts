/**
 * Native RLM Mode integration tests.
 * Run: bun run pi-plugin/rlm/test/native-mode.ts
 *
 * Tests: SandboxManager lifecycle, formatForLLM(), buildNativeSystemPrompt(),
 * and ReplDetails type structure.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, fail, failureCount } from "./helpers.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { formatForLLM } from "../src/context/repomix-context.ts";
import { buildNativeSystemPrompt } from "../src/prompts/system.ts";
import { buildReplResultText, surfaceReplEdits } from "../src/tool/repl-tool.ts";
import { createApplyEditsTool, diffStats } from "../src/tool/apply-edits-tool.ts";
import { EditRegistry } from "../src/registry/edit-registry.ts";
import type { ContextBundle } from "../src/context/repomix-context.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";


// ── formatForLLM tests ──

function testFormatForLLM() {
  const empty: ContextBundle = { files: [], totalFiles: 0, totalTokens: 0, totalChars: 0 };
  const out = formatForLLM(empty);
  check("formatForLLM empty bundle — non-empty", out.length > 0);
  check("formatForLLM empty bundle — shows 0 files", out.includes("0 files"));
  check("formatForLLM empty bundle — includes hint", out.includes("pre-loaded in the REPL"));

  const small: ContextBundle = {
    files: [
      { path: "a.ts", content: "const x = 1;", tokens: 5 },
      { path: "b.ts", content: "const y = 2;", tokens: 5 },
    ],
    totalFiles: 2, totalTokens: 10, totalChars: 24,
  };
  const out2 = formatForLLM(small);
  check("formatForLLM small bundle — shows file paths", out2.includes("a.ts") && out2.includes("b.ts"));
  check("formatForLLM small bundle — shows token counts", out2.includes("5 tok"));
  check("formatForLLM small bundle — shows char counts", out2.includes("chars"));
  check("formatForLLM small bundle — no truncation", !out2.includes("truncated"));

  // Large bundle simulation
  const files = Array.from({ length: 250 }, (_, i) => ({
    path: `src/file${i}.ts`, content: "x", tokens: 1,
  }));
  const large: ContextBundle = { files, totalFiles: 250, totalTokens: 250, totalChars: 250 };
  const out3 = formatForLLM(large);
  check("formatForLLM large bundle — truncates", out3.includes("more files (truncated)"));
  check("formatForLLM large bundle — shows total", out3.includes("250 files"));
}

// ── buildNativeSystemPrompt tests ──

function testNativeSystemPrompt() {
  const prompt = buildNativeSystemPrompt();
  check("buildNativeSystemPrompt — non-empty", prompt.length > 500);
  check("buildNativeSystemPrompt — contains mode marker", prompt.includes("NATIVE RLM MODE"));
  check("buildNativeSystemPrompt — mentions repl tool", prompt.includes("repl({code"));
  check("buildNativeSystemPrompt — mentions context", prompt.includes("context"));
  check("buildNativeSystemPrompt — mentions llm_query", prompt.includes("llm_query"));
  check("buildNativeSystemPrompt — mentions rlm_query", prompt.includes("rlm_query"));
  check("buildNativeSystemPrompt — mentions orchestrator", prompt.includes("orchestrator, not a solver"));
  check("buildNativeSystemPrompt — mentions chunking", prompt.includes("chunk_size"));
  check("buildNativeSystemPrompt — mentions answer dict", prompt.includes("answer[\"ready\"]"));
  check("buildNativeSystemPrompt — mentions apply_edits", prompt.includes("apply_edits({ ids"));
  check("buildNativeSystemPrompt — no stale edit relay", !prompt.includes("relay STAGED_EDITS to `edit`"));
  check("buildNativeSystemPrompt — mentions native tools", prompt.includes("zebra-mcp"));
}

function testStagedEditSurfacing() {
  const edits = Object.freeze([{ id: "e1", path: "a.ts", oldText: "old", newText: "new" }]);
  check("surfaceReplEdits — successful exec exposes staged edits", surfaceReplEdits(edits, false) === edits);
  check("surfaceReplEdits — raised exec discards staged edits", surfaceReplEdits(edits, true) === undefined);
  check("surfaceReplEdits — empty edits stay hidden", surfaceReplEdits(Object.freeze([]), false) === undefined);
}

function testAnswerSubmittedSummary() {
  const result = buildReplResultText("stdout", "final answer", Object.freeze([]), false, []);
  check("buildReplResultText — final answer by reference", result.text.includes("ANSWER_SUBMITTED (12 chars)"));
  check("buildReplResultText — final answer content hidden", !result.text.includes("final answer"));
}

function contextFor(cwd: string): ExtensionContext {
  return {
    ui: undefined as unknown as ExtensionContext["ui"],
    mode: "tui",
    hasUI: false,
    cwd,
    sessionManager: undefined as unknown as ExtensionContext["sessionManager"],
    modelRegistry: undefined as unknown as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
}

async function testApplyEditsTool() {
  const cwd = await mkdtemp(join(tmpdir(), "rlm-apply-edits-"));
  try {
    const registry = new EditRegistry();
    const tool = createApplyEditsTool(registry);
    const ctx = contextFor(cwd);

    await writeFile(join(cwd, "a.ts"), "const value = 'old';\n", "utf8");
    registry.registerAll([{ id: "e1", path: "a.ts", oldText: "old", newText: "new" }]);
    const success = await tool.execute("apply-1", { ids: ["e1"] }, undefined, undefined, ctx);
    const updated = await readFile(join(cwd, "a.ts"), "utf8");
    check("apply_edits — applies known id", success.details?.status === "done" && updated.includes("new"));
    check("apply_edits — reports applied file stats", success.details?.appliedCount === 1 && success.details.fileStats[0]?.status === "applied");
    check("apply_edits — reports line stats", success.details?.fileStats[0]?.added === 0 && success.details.fileStats[0]?.removed === 0);
    check("apply_edits — deletes applied id", registry.get("e1") === undefined);

    const unknown = await tool.execute("apply-2", { ids: ["missing"] }, undefined, undefined, ctx);
    check("apply_edits — unknown id fails softly", unknown.details?.status === "error" && unknown.details.errors[0]?.id === "missing");
    check("apply_edits — unknown id reports failed file stats", unknown.details?.failedCount === 1 && unknown.details.fileStats[0]?.status === "failed");

    await writeFile(join(cwd, "b.ts"), "old old\n", "utf8");
    registry.registerAll([{ id: "e2", path: "b.ts", oldText: "old", newText: "new" }]);
    const mismatch = await tool.execute("apply-3", { ids: ["e2"] }, undefined, undefined, ctx);
    check("apply_edits — duplicate anchor rejected", mismatch.details?.status === "error" && mismatch.details.errors[0]?.error.includes("anchor occurs 2"));
    check("apply_edits — rejected id remains registered", registry.get("e2") !== undefined);

    const added = diffStats("one\n", "one\ntwo\n");
    const removed = diffStats("one\ntwo\n", "one\n");
    check("apply_edits — diffStats counts added lines", added.added === 1 && added.removed === 0);
    check("apply_edits — diffStats counts removed lines", removed.added === 0 && removed.removed === 1);

    registry.clear();
    check("EditRegistry — clear removes unapplied ids", registry.get("e2") === undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ── SandboxManager tests ──

async function testSandboxManager() {
  let discardedCount = 0;
  const mgr = new SandboxManager({
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    sandboxInitTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    onSandboxDiscarded: () => { discardedCount++; },
  });

  // Lifecycle
  check("SandboxManager — not alive before getOrCreate", !mgr.isAlive);
  check("SandboxManager — not executing before any exec", !mgr.isExecuting);

  // Create sandbox with empty handlers
  await mgr.getOrCreate({});
  check("SandboxManager — alive after getOrCreate", mgr.isAlive);

  // Basic exec
  const r1 = await mgr.exec("print('hello native')");
  check("SandboxManager exec — returns stdout", r1.stdout.includes("hello native"));
  check("SandboxManager exec — executionTimeMs >= 0", r1.executionTimeMs >= 0);

  // REPL state persistence
  await mgr.exec("x = 42");
  const r2 = await mgr.exec("print(x)");
  check("SandboxManager — REPL state persists across calls", r2.stdout.includes("42"));

  // propose_diff was removed from the namespace — calling it raises NameError.
  const r3 = await mgr.exec("print(callable(propose_diff))");
  check("SandboxManager — propose_diff removed from namespace (NameError)", r3.raised && r3.stderr.includes("NameError"));

  // stage_edit records exact edit payloads and clears them after each exec.
  const staged = await mgr.exec([
    "print(stage_edit('test.ts', 'old', 'new'))",
    "print(stage_edit('bar.ts', 'a', 'b'))",
  ].join("\n"));
  const expectedEdits = JSON.stringify([
    { id: "e1", path: "test.ts", oldText: "old", newText: "new" },
    { id: "e2", path: "bar.ts", oldText: "a", newText: "b" },
  ]);
  check("SandboxManager — stage_edit returns edit IDs", staged.stdout.includes("e1") && staged.stdout.includes("e2"));
  check("SandboxManager — stage_edit returns edits", JSON.stringify(staged.edits) === expectedEdits);

  const cleared = await mgr.exec("print('no edits staged')");
  check("SandboxManager — stage_edit clears after return", cleared.edits.length === 0);

  // Idempotent dispose
  await mgr.dispose();
  check("SandboxManager — not alive after dispose", !mgr.isAlive);
  check("SandboxManager — discard callback fires on dispose", discardedCount === 1, String(discardedCount));
  await mgr.dispose(); // second dispose should not throw
  check("SandboxManager — double dispose safe", true);
  check("SandboxManager — double dispose does not double discard", discardedCount === 1, String(discardedCount));
}

// ── Main ──

async function main() {
  console.log("─── formatForLLM ───");
  testFormatForLLM();

  console.log("\n─── buildNativeSystemPrompt ───");
  testNativeSystemPrompt();

  console.log("\n─── Staged edit surfacing ───");
  testStagedEditSurfacing();
  testAnswerSubmittedSummary();

  console.log("\n─── apply_edits ───");
  try {
    await testApplyEditsTool();
  } catch (err) {
    console.error("apply_edits tests failed:", err instanceof Error ? err.message : String(err));
    fail();
  }

  console.log("\n─── SandboxManager ───");
  try {
    await testSandboxManager();
  } catch (err) {
    console.error("SandboxManager tests failed:", err instanceof Error ? err.message : String(err));
    fail();
  }

  console.log(`\n${failureCount() === 0 ? "✓ All tests passed" : `✗ ${failureCount()} failure(s)`}`);
  process.exit(failureCount() > 0 ? 1 : 0);
}

await main();
