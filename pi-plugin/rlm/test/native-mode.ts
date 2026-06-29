/**
 * Native RLM Mode integration tests.
 * Run: bun run pi-plugin/rlm/test/native-mode.ts
 *
 * Tests: SandboxManager lifecycle, formatForLLM(), buildNativeSystemPrompt(),
 * and ReplDetails type structure.
 */

import { check, fail, failureCount } from "./helpers.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { formatForLLM } from "../src/context/repomix-context.ts";
import { buildNativeSystemPrompt } from "../src/prompts/system.ts";
import { surfaceReplEdits } from "../src/tool/repl-tool.ts";
import type { ContextBundle } from "../src/context/repomix-context.ts";


// ── formatForLLM tests ──

function testFormatForLLM() {
  const empty: ContextBundle = { files: [], totalFiles: 0, totalTokens: 0, totalChars: 0 };
  const out = formatForLLM(empty);
  check("formatForLLM empty bundle — non-empty", out.length > 0);
  check("formatForLLM empty bundle — shows 0 files", out.includes("0 files"));
  check("formatForLLM empty bundle — includes hint", out.includes("To read a file"));

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
  check("buildNativeSystemPrompt — mentions native tools", prompt.includes("zebra-mcp"));
}

function testStagedEditSurfacing() {
  const edits = Object.freeze([{ path: "a.ts", oldText: "old", newText: "new" }]);
  check("surfaceReplEdits — successful exec exposes staged edits", surfaceReplEdits(edits, false) === edits);
  check("surfaceReplEdits — raised exec discards staged edits", surfaceReplEdits(edits, true) === undefined);
  check("surfaceReplEdits — empty edits stay hidden", surfaceReplEdits(Object.freeze([]), false) === undefined);
}

// ── SandboxManager tests ──

async function testSandboxManager() {
  const mgr = new SandboxManager({
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    sandboxInitTimeoutMs: 30_000,
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
    { path: "test.ts", oldText: "old", newText: "new" },
    { path: "bar.ts", oldText: "a", newText: "b" },
  ]);
  check("SandboxManager — stage_edit reports staged edit", staged.stdout.includes("Staged edit for test.ts"));
  check("SandboxManager — stage_edit returns edits", JSON.stringify(staged.edits) === expectedEdits);

  const cleared = await mgr.exec("print('no edits staged')");
  check("SandboxManager — stage_edit clears after return", cleared.edits.length === 0);

  // Idempotent dispose
  await mgr.dispose();
  check("SandboxManager — not alive after dispose", !mgr.isAlive);
  await mgr.dispose(); // second dispose should not throw
  check("SandboxManager — double dispose safe", true);
}

// ── Main ──

async function main() {
  console.log("─── formatForLLM ───");
  testFormatForLLM();

  console.log("\n─── buildNativeSystemPrompt ───");
  testNativeSystemPrompt();

  console.log("\n─── Staged edit surfacing ───");
  testStagedEditSurfacing();

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

main();
