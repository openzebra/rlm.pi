/**
 * Phase-chunked verification — llm_query_chunked helper, large-file delegation rules,
 * huge-variable nudge, and scaffold restoration. Drives PythonSandbox directly (no pi, no real LLM).
 * Run: bun run pi-plugin/rlm/test/phase-chunked.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { buildRlmSystemPrompt, NATIVE_PROMPT_STATIC } from "../src/prompts/system.ts";

async function main() {
  // 1. Chunking + cap: spawn with a small cap; the fake batched handler records every sub-prompt.
  const received: string[][] = [];
  const sb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 10_000,
    handlers: {
      llmQueryBatched: async (prompts) => {
        received.push([...prompts]);
        return prompts.map((_, i) => `r${i}`);
      },
    },
  });
  const res = await sb.exec('print(len(llm_query_chunked("x" * 25_000, "Q")))');
  check("chunked splits 25K under a 10K cap into 3 chunks", res.stdout.trim() === "3", res.stdout.trim());
  const flat = received.flat();
  check(
    "every sub-prompt stays under the cap",
    flat.length > 0 && flat.every((p) => p.length <= 10_000),
    `max len=${flat.length ? Math.max(...flat.map((p) => p.length)) : 0}`,
  );
  check("chunk numbering/order preserved", flat[0]?.includes("[chunk 1/3"), flat[0]?.slice(0, 40));

  // 2. Empty text → no sub-calls, returns [].
  const empty = await sb.exec('print(llm_query_chunked("", "Q"))');
  check("empty text yields [] with no sub-calls", empty.stdout.trim() === "[]", empty.stdout.trim());

  // Scaffold restoration: model clobbers llm_query_chunked, next exec re-injects it.
  await sb.exec("llm_query_chunked = 'clobbered'");
  const clobbered = await sb.exec('print(len(llm_query_chunked("hi", "Q")))');
  check(
    "llm_query_chunked restored after clobber",
    clobbered.stdout.trim() === "1" && !clobbered.raised,
    clobbered.stdout.trim(),
  );

  // 2b. Tiny budget (prompt near the cap) returns one error, never thousands of chunks.
  const beforeCalls = received.length;
  const tiny = await sb.exec('print(llm_query_chunked("data", "z" * 9000))');
  check(
    "tiny budget returns an error without fanning out",
    tiny.stdout.includes("Error:") && tiny.stdout.includes("1,000") && received.length === beforeCalls,
    tiny.stdout.trim().slice(0, 80),
  );
  await sb.dispose();

  // 2c. Chunk ceiling: a small cap + large input exceeds the 500-chunk cap → error.
  const csb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 1500,
    handlers: { llmQueryBatched: async (p) => p.map((_, i) => `c${i}`) },
  });
  const ceiling = await csb.exec('print(llm_query_chunked("x" * 720_000, "Q"))');
  check(
    "chunk ceiling guards against explosion",
    ceiling.stdout.includes("Error:") && ceiling.stdout.includes("500"),
    ceiling.stdout.trim().slice(0, 80),
  );
  await csb.dispose();

  // 3. Nudge fires once per variable, collapsed to a single stdout line.
  const nb = await PythonSandbox.spawn({ depth: 1 });
  const first = await nb.exec('raw = "a" * 600_000');
  check(
    "nudge fires for a newly created huge variable",
    first.stdout.includes("[rlm] huge raw-text variable(s)") && first.stdout.includes("raw (600,000 chars)"),
    first.stdout.trim().slice(0, 90),
  );
  const second = await nb.exec("print(len(raw))");
  check(
    "nudge fires only once per variable",
    !second.stdout.includes("[rlm]"),
    second.stdout.trim(),
  );

  // 3b. Multiple huge vars created in one block → a single nudge line lists them all
  // (avoids losing lines to headless stdout elision).
  const multi = await nb.exec('a = "x" * 600_000\nb = "y" * 700_000');
  const nudgeMatches = multi.stdout.match(/\[rlm\]/g);
  check(
    "multiple huge vars collapse to one nudge line listing each",
    (nudgeMatches?.length ?? 0) === 1 && multi.stdout.includes("a (600,000 chars)") && multi.stdout.includes("b (700,000 chars)"),
    multi.stdout.trim().slice(0, 120),
  );
  await nb.dispose();

  // 4. Prompt surface — both headless and native variants advertise the helper.
  const sys = buildRlmSystemPrompt({ contextType: "json", contextChars: 10 }, {});
  check("headless prompt documents llm_query_chunked", sys.includes("llm_query_chunked"), "");
  check("headless prompt notes context exclusions", sys.includes("NOT in `context`"), "");
  check("native prompt documents llm_query_chunked", NATIVE_PROMPT_STATIC.includes("llm_query_chunked"), "");

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
