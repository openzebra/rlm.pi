/**
 * Phase 1 verification — drives PythonSandbox directly (no pi, no real LLM).
 * Run: bun run pi-plugin/rlm/test/phase1.ts
 */

import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { findReplBlocks, truncateOutput } from "../src/text/parsing.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  // Set a provider key BEFORE spawning, to prove the sandbox env is sanitized.
  process.env.ANTHROPIC_API_KEY = "sk-should-not-be-visible";
  process.env.OPENAI_API_KEY = "sk-also-hidden";

  // parsing
  const blocks = findReplBlocks("think\n```repl\nprint(1)\n```\nmore\n```repl\nx=2\n```");
  check("findReplBlocks extracts 2 blocks", blocks.length === 2, JSON.stringify(blocks));
  check("truncateOutput elides", truncateOutput("a".repeat(100), 40).includes("elided"));

  const sandbox = await PythonSandbox.spawn({
    depth: 1,
    execTimeoutS: 2,
    handlers: {
      llmQuery: async (prompt) => `STUB(${prompt.slice(0, 20)})`,
      llmQueryBatched: async (prompts) => prompts.map((p, i) => `STUB${i}(${p.slice(0, 10)})`),
    },
  });

  // context load + probe
  await sandbox.loadContext(["doc one", "doc two", "doc three"]);
  let r = await sandbox.exec("print(type(context).__name__, len(context))");
  check("context loaded as list", r.stdout.trim() === "list 3", r.stdout.trim());

  // persistence across turns
  await sandbox.exec("acc = []");
  r = await sandbox.exec("acc.append('x'); print(len(acc))");
  check("vars persist across exec calls", r.stdout.trim() === "1", r.stdout.trim());

  // SHOW_VARS
  r = await sandbox.exec("print(SHOW_VARS())");
  check("SHOW_VARS lists user vars", r.stdout.includes("acc"), r.stdout.trim());

  // sub-LLM bridge over stdio (mid-exec interrupt -> stub handler)
  r = await sandbox.exec("print(llm_query('summarize ' + context[0]))");
  check("llm_query reaches stub handler", r.stdout.includes("STUB(summarize doc one"), r.stdout.trim());

  r = await sandbox.exec("print(llm_query_batched([c for c in context]))");
  check("llm_query_batched returns ordered list", r.stdout.includes("STUB0") && r.stdout.includes("STUB2"), r.stdout.trim());

  // key isolation: the sandbox must not see provider keys (stripped at spawn)
  r = await sandbox.exec(
    "import os; print('A=' + str(os.environ.get('ANTHROPIC_API_KEY')) + ' O=' + str(os.environ.get('OPENAI_API_KEY')))",
  );
  check("sandbox cannot read provider keys", r.stdout.trim() === "A=None O=None", r.stdout.trim());

  // answer.ready -> final answer surfaced
  r = await sandbox.exec("answer['content'] = '42'; answer['ready'] = True");
  check("answer.ready surfaces final answer", r.finalAnswer === "42", String(r.finalAnswer));

  // stderr on error
  r = await sandbox.exec("1/0");
  check("error captured in stderr", r.stderr.includes("ZeroDivisionError"), r.stderr.trim().slice(0, 60));

  // per-block timeout -> watchdog/SIGALRM kills the block (not the whole process)
  r = await sandbox.exec("while True:\n    pass");
  check("infinite loop hits exec timeout", r.stderr.includes("timeout"), r.stderr.trim().slice(0, 80));

  // sandbox still alive after timeout
  r = await sandbox.exec("print('alive')");
  check("sandbox survives a timed-out block", r.stdout.trim() === "alive", r.stdout.trim());

  await sandbox.dispose();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
