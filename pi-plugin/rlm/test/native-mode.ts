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
import { buildReplResultText, collectReplWarnings } from "../src/tool/repl-tool.ts";
import type { ContextBundle } from "../src/context/repomix-context.ts";
import type { RlmSubcall } from "../src/tool/rlm-details.ts";


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
  check("buildNativeSystemPrompt — authoring rule", prompt.includes("AUTHORING RULE"));
  check("buildNativeSystemPrompt — native edit", prompt.includes("`edit`"));
  check("buildNativeSystemPrompt — no stage_edit", !prompt.includes("stage_edit"));
  check("buildNativeSystemPrompt — no apply_edits", !prompt.includes("apply_edits"));
  check("buildNativeSystemPrompt — mentions native tools", prompt.includes("zebra-mcp"));
}

function testAnswerSubmittedSummary() {
  const result = buildReplResultText("stdout", "final answer", []);
  check("buildReplResultText — final answer by reference", result.text.includes("ANSWER_SUBMITTED (12 chars)"));
  check("buildReplResultText — final answer content hidden", !result.text.includes("final answer"));
}

function testCollectReplWarnings() {
  const ok: readonly RlmSubcall[] = Object.freeze([
    { id: "s1", depth: 0, kind: "llm", label: "a", status: "done", startedAt: 0, costUsd: 0, tokens: 0 },
  ]);
  check("collectReplWarnings — none when all ok", collectReplWarnings(ok) === undefined);

  const mixed: readonly RlmSubcall[] = Object.freeze([
    { id: "s1", depth: 0, kind: "llm", label: "a", status: "done", startedAt: 0, costUsd: 0, tokens: 0 },
    { id: "s2", depth: 0, kind: "llm", label: "b", status: "error", startedAt: 0, costUsd: 0, tokens: 0 },
  ]);
  const w = collectReplWarnings(mixed);
  check("collectReplWarnings — single error is 1/1", w !== undefined && w[0] === "1/1 sub-call(s) failed — results may be incomplete");

  // Batch subcall: 3 of 8 prompts failed — must report real counts, not 1/1.
  const batch: readonly RlmSubcall[] = Object.freeze([
    {
      id: "s1", depth: 0, kind: "batch", label: "llm_query ×8", status: "error",
      startedAt: 0, costUsd: 0, tokens: 0, failedCount: 3, totalCount: 8,
    },
  ]);
  const bw = collectReplWarnings(batch);
  check(
    "collectReplWarnings — batch reports real prompt counts",
    bw !== undefined && bw[0] === "3/8 sub-call(s) failed — results may be incomplete",
    bw?.[0],
  );
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

  // stage_edit was removed — calling it raises NameError.
  const gone = await mgr.exec("print(stage_edit)");
  check("SandboxManager — stage_edit removed (NameError)", gone.raised && gone.stderr.includes("NameError"));

  // Core surface still present (context is only set after loadContext)
  const alive = await mgr.exec("print(callable(llm_query), callable(SHOW_VARS), callable(load_library))");
  check("SandboxManager — core REPL surface intact", !alive.raised && alive.stdout.includes("True True True"));

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

  console.log("\n─── Result text / warnings ───");
  testAnswerSubmittedSummary();
  testCollectReplWarnings();

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
