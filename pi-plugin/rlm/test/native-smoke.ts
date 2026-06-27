/**
 * Native RLM Mode — integration smoke test on THIS project (rlm.pi).
 *
 * Tests the full pipeline without real LLM API calls:
 *   1. repomix packs the project → formatForLLM produces listing
 *   2. SandboxManager loads context into Python REPL
 *   3. repl() tool executes code via the persistent sandbox
 *   4. REPL state persists across multiple repl() calls
 *   5. context variable is accessible in the sandbox (file paths, content)
 *   6. llm_query/rlm_query/todo handlers are wired (but NOT invoked — no API cost)
 *
 * Run: bun run pi-plugin/rlm/test/native-smoke.ts
 */

import { check, failureCount } from "./helpers.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { packRepository, formatForLLM, serializeForSandbox } from "../src/context/repomix-context.ts";
import { buildNativeSystemPrompt, buildRlmSystemPrompt } from "../src/prompts/system.ts";
import type { ContextBundle } from "../src/context/repomix-context.ts";
import { contextLength, contextTypeLabel } from "../src/text/tokens.ts";


// ── 1. repomix packs the project ──

const cwd = process.cwd();
console.log(`\n─── Packing project: ${cwd} ───`);

const packResult = await packRepository(cwd);
check("repomix pack — ok", packResult.ok);
if (!packResult.ok) {
  console.error(`  Error: ${packResult.error}`);
  process.exit(1);
}

const bundle: ContextBundle = packResult.value;
console.log(`  Files: ${bundle.totalFiles}, Tokens: ${bundle.totalTokens.toLocaleString()}, Chars: ${bundle.totalChars.toLocaleString()}`);
check("repomix pack — has files", bundle.totalFiles > 0);
check("repomix pack — has tokens", bundle.totalTokens > 0);
check("repomix pack — files array matches count", bundle.files.length === bundle.totalFiles);

// ── 2. formatForLLM produces compact listing ──

const listing = formatForLLM(bundle);
console.log(`\n─── formatForLLM output (first 3 lines) ───`);
listing.split("\n").slice(0, 3).forEach(l => console.log(`  ${l.slice(0, 100)}`));

check("formatForLLM — non-empty on real project", listing.length > 100);
check("formatForLLM — contains 'Repository context'", listing.includes("Repository context"));
check("formatForLLM — contains file paths", listing.includes(".ts") || listing.includes(".json"));
check("formatForLLM — contains 'To read a file' hint", listing.includes("To read a file"));

// If project > 200 files, check truncation
if (bundle.totalFiles > 200) {
  check("formatForLLM — truncates large projects", listing.includes("more files"));
}

// ── 3. System prompts ──

const nativePrompt = buildNativeSystemPrompt();
check("native prompt — contains [NATIVE RLM MODE]", nativePrompt.includes("NATIVE RLM MODE"));
check("native prompt — mentions repl", nativePrompt.includes("repl"));

const meta = { contextType: contextTypeLabel(bundle), contextChars: contextLength(bundle) };
const fullPrompt = buildRlmSystemPrompt(meta, { orchestrator: true, recursion: true, askUserQuestion: true, todo: true });
check("rlm system prompt — non-empty", fullPrompt.length > 500);
check("rlm system prompt — mentions llm_query", fullPrompt.includes("llm_query"));
check("rlm system prompt — mentions rlm_query", fullPrompt.includes("rlm_query"));
check("rlm system prompt — mentions context variable", fullPrompt.includes("context"));
check("rlm system prompt — mentions answer dict", fullPrompt.includes("answer"));
check("rlm system prompt — orchestrator addendum", fullPrompt.includes("orchestrator, not a solver"));

// ── 4. SandboxManager + context loading + REPL execution ──

console.log(`\n─── SandboxManager with real context ───`);

const mgr = new SandboxManager({
  execTimeoutS: 30,
  requestTimeoutMs: 30_000,
  python: "python3",
  sandboxInitTimeoutMs: 30_000,
});

// Store context payload (same as index.ts does)
mgr.contextPayload = serializeForSandbox(bundle);

// Create sandbox — loads context on first getOrCreate
await mgr.getOrCreate({});
check("SandboxManager — alive after getOrCreate with context", mgr.isAlive);

// Verify context is accessible in REPL
const r1 = await mgr.exec(`
print(f"context type: {type(context)}")
print(f"context length: {len(context)}")
print(f"first file: {context[0]['path']}")
print(f"first file tokens: {context[0]['tokens']}")
`);
check("REPL — context is a list", r1.stdout.includes("context type: <class 'list'>") || r1.stdout.includes("list"));
check("REPL — context has items", r1.stdout.includes(`context length: ${bundle.totalFiles}`));
const firstFile = bundle.files[0];
check("REPL — first file path accessible", firstFile !== undefined && r1.stdout.includes(firstFile.path));
check("REPL — first file tokens accessible", firstFile !== undefined && r1.stdout.includes(String(firstFile.tokens)));

// Context content is accessible
const r2 = await mgr.exec(`
f = context[0]
content_preview = f['content'][:100]
print(f"path: {f['path']}")
print(f"content preview: {content_preview}")
`);
check("REPL — file content accessible", r2.stdout.includes("content preview:"));

// ── 5. REPL state persistence ──

const r3 = await mgr.exec(`
import json
file_count = len(context)
total_tokens = sum(f['tokens'] for f in context)
print(f"Total files counted: {file_count}")
print(f"Total tokens computed: {total_tokens}")
`);
check("REPL — can compute over context", r3.stdout.includes("Total files counted:"));
check("REPL — token computation works", r3.stdout.includes("Total tokens computed:"));

// Verify variables persist
const r4 = await mgr.exec(`print(f"file_count still here: {file_count}")`);
check("REPL — state persists (file_count)", r4.stdout.includes(`file_count still here: ${bundle.totalFiles}`));

// ── 6. llm_query handler is wired (not invoked — no API cost) ──

const r5 = await mgr.exec(`
# Verify llm_query function exists (don't call it — no API key in test)
import inspect
sig = inspect.signature(llm_query)
print(f"llm_query signature: {sig}")
`);
check("REPL — llm_query function exists", r5.stdout.includes("llm_query signature"));

const r6 = await mgr.exec(`
# Verify rlm_query function exists
sig = inspect.signature(rlm_query)
print(f"rlm_query signature: {sig}")
`);
check("REPL — rlm_query function exists", r6.stdout.includes("rlm_query signature"));

const r7 = await mgr.exec(`
# Verify todo function exists
sig = inspect.signature(todo)
print(f"todo signature: {sig}")
`);
check("REPL — todo function exists", r7.stdout.includes("todo signature"));

const r8 = await mgr.exec(`
# Verify SHOW_VARS works
result = SHOW_VARS()
print(f"SHOW_VARS ok: len={len(result)}")
print(f"SHOW_VARS sample: {result[:200]}")
`);
check("REPL — SHOW_VARS works", r8.stdout.includes("SHOW_VARS ok"));
check("REPL — SHOW_VARS returns data", r8.stdout.includes("SHOW_VARS sample"));

// ── 7. Cleanup ──

await mgr.dispose();
check("SandboxManager — disposed", !mgr.isAlive);

// ── 8. Native prompt sanity ──

const nativeOnly = buildNativeSystemPrompt();
check("native prompt — under 6K chars standalone", nativeOnly.length < 6000,
      ` (${nativeOnly.length.toLocaleString()} chars)`);
check("native prompt — includes REPL glossary", nativeOnly.includes("REPL Environment"));
check("native prompt — includes workflow steps", nativeOnly.includes("Workflow"));
check("native prompt — includes tool table", nativeOnly.includes("Choosing Between Tools"));

// ── Results ──

console.log(`\n${failureCount() === 0 ? "✓ All integration tests passed" : `✗ ${failureCount()} failure(s)`}`);
process.exit(failureCount() > 0 ? 1 : 0);
