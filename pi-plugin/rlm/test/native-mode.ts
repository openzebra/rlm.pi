/**
 * Native RLM Mode integration tests.
 * Run: bun run pi-plugin/rlm/test/native-mode.ts
 *
 * Tests: SandboxManager lifecycle, formatForLLM(), buildNativeSystemPrompt(),
 * and ReplDetails type structure.
 */

import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { formatForLLM } from "../src/context/repomix-context.ts";
import { buildNativeSystemPrompt } from "../src/prompts/system.ts";
import type { ContextBundle } from "../src/context/repomix-context.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

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
  check("buildNativeSystemPrompt — non-empty", prompt.length > 0);
  check("buildNativeSystemPrompt — contains mode marker", prompt.includes("NATIVE RLM MODE"));
  check("buildNativeSystemPrompt — mentions repl tool", prompt.includes("repl"));
  check("buildNativeSystemPrompt — mentions normal tools", prompt.includes("read") || prompt.includes("grep") || prompt.includes("tools"));
  check("buildNativeSystemPrompt — no advance_phase", !prompt.includes("advance_phase"));
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

  console.log("\n─── SandboxManager ───");
  try {
    await testSandboxManager();
  } catch (err) {
    console.error("SandboxManager tests failed:", err instanceof Error ? err.message : String(err));
    failures++;
  }

  console.log(`\n${failures === 0 ? "✓ All tests passed" : `✗ ${failures} failure(s)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
