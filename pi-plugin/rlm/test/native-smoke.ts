/**
 * Native RLM Mode — integration smoke test on THIS project (rlm.pi).
 *
 * Tests the full pipeline without real LLM API calls:
 *   1. resolveSource packs the project → formatContextListing produces listing
 *   2. SandboxManager loads context into Python REPL
 *   3. REPL state persists across multiple calls
 *   4. context variable is accessible in the sandbox
 *   5. llm_query/rlm_query handlers are wired (but NOT invoked — no API cost)
 *
 * Run: bun run pi-plugin/rlm/test/native-smoke.ts
 */

import { check, failureCount } from "./helpers.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { resolveSource } from "../src/context/resolve.ts";
import { formatContextListing } from "../src/context/listing.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { buildNativeSystemPrompt, NATIVE_PROMPT_BUDGET } from "../src/prompts/native.ts";
import { contextLength, contextTypeLabel } from "../src/text/tokens.ts";


// ── 1. resolveSource packs the project ──

const cwd = process.cwd();
console.log(`\n─── Packing project: ${cwd} ───`);

const packResult = await resolveSource(cwd, { cwd, pathPrefix: "" });
check("resolveSource pack — ok", packResult.ok);
if (!packResult.ok) {
  console.error(`  Error: ${packResult.error}`);
  process.exit(1);
}

const files = packResult.value.payload;
const totalFiles = files.length;
let totalTokens = 0;
let totalChars = 0;
for (let i = 0; i < files.length; i++) {
  totalTokens += files[i].tokens;
  totalChars += files[i].content.length;
}
console.log(`  Files: ${totalFiles}, Tokens: ${totalTokens.toLocaleString()}, Chars: ${totalChars.toLocaleString()}`);
check("resolveSource pack — has files", totalFiles > 0);
check("resolveSource pack — has tokens", totalTokens > 0);

// ── 2. formatContextListing produces compact listing ──

const listing = formatContextListing(files);
console.log(`\n─── formatContextListing output (first 3 lines) ───`);
listing.split("\n").slice(0, 3).forEach(l => console.log(`  ${l.slice(0, 100)}`));

check("formatContextListing — non-empty on real project", listing.length > 100);
check("formatContextListing — contains 'Context:'", listing.includes("Context:"));
check("formatContextListing — contains file paths", listing.includes(".ts") || listing.includes(".json"));
check("formatContextListing — contains repl delegation hint", listing.includes("llm_batch"));

if (totalFiles > 200) {
  check("formatContextListing — truncates large projects", listing.includes("more files"));
}

// ── 3. System prompts ──

const nativePrompt = buildNativeSystemPrompt();
check("native prompt — contains [NATIVE RLM MODE]", nativePrompt.includes("NATIVE RLM MODE"));
check("native prompt — mentions repl", nativePrompt.includes("repl"));

const meta = { contextType: contextTypeLabel(files), contextChars: contextLength(files) };
const fullPrompt = buildRlmSystemPrompt(meta, { orchestrator: true, recursion: true });
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
  maxPromptChars: 400_000,
  awaitTimeoutS: 30,
});

mgr.contextPayload = files;

await mgr.getOrCreate({});
check("SandboxManager — alive after getOrCreate with context", mgr.isAlive);

const r1 = await mgr.exec(`
print(f"context type: {type(context)}")
print(f"context length: {len(context)}")
print(f"first file: {context[0]['path']}")
print(f"first file tokens: {context[0]['tokens']}")
`);
check("REPL — context is a list", r1.stdout.includes("context type: <class 'list'>") || r1.stdout.includes("list"));
check("REPL — context has items", r1.stdout.includes(`context length: ${totalFiles}`));
const firstFile = files[0];
check("REPL — first file path accessible", firstFile !== undefined && r1.stdout.includes(firstFile.path));
check("REPL — first file tokens accessible", firstFile !== undefined && r1.stdout.includes(String(firstFile.tokens)));

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

const r4 = await mgr.exec(`print(f"file_count still here: {file_count}")`);
check("REPL — state persists (file_count)", r4.stdout.includes(`file_count still here: ${totalFiles}`));

// ── 6. llm_query handler is wired (not invoked — no API cost) ──

const r5 = await mgr.exec(`
import inspect
sig = inspect.signature(llm_query)
print(f"llm_query signature: {sig}")
`);
check("REPL — llm_query function exists", r5.stdout.includes("llm_query signature"));

const r6 = await mgr.exec(`
sig = inspect.signature(rlm_query)
print(f"rlm_query signature: {sig}")
`);
check("REPL — rlm_query function exists", r6.stdout.includes("rlm_query signature"));

const r7 = await mgr.exec(`
try:
    ask_user_question
    print("ask_user_question still present")
except NameError:
    print("ask_user_question removed")
`);
check("REPL — ask_user_question removed", r7.stdout.includes("ask_user_question removed"));

const r8 = await mgr.exec(`
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
check("native prompt — within the documented budget", nativeOnly.length < NATIVE_PROMPT_BUDGET,
      ` (${nativeOnly.length.toLocaleString()} / ${NATIVE_PROMPT_BUDGET.toLocaleString()} chars)`);
check("native prompt — includes REPL glossary", nativeOnly.includes("REPL surface"));
check("native prompt — includes the decomposition doctrine", nativeOnly.includes("LOCATE-THEN-DELEGATE"));
check("native prompt — includes worked examples", nativeOnly.includes("E1 multi-area study"));
check("native prompt — includes tool table", nativeOnly.includes("Always-spawn fan-out"));
check("native prompt — guides native edit/write", nativeOnly.includes("edit") && nativeOnly.includes("write"));

// ── Results ──

console.log(`\n${failureCount() === 0 ? "✓ All integration tests passed" : `✗ ${failureCount()} failure(s)`}`);
process.exit(failureCount() > 0 ? 1 : 0);
