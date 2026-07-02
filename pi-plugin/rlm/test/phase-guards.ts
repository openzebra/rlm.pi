/**
 * Phase-guards verification — native-mode bash steering/capping, prompt budget, and
 * llm_query_chunked guardrails.
 * Run: bun run pi-plugin/rlm/test/phase-guards.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { NATIVE_PROMPT_STATIC } from "../src/prompts/system.ts";
import { bashCommandFromInput, capToolResultText, isFileReadingCommand } from "../src/mode/native-guards.ts";

async function main() {
  const blocked = Object.freeze([
    "sed -n '231,255p' worker.py",
    "cat foo.json | head",
    "cd /x && sed -n '1p' y",
    "RUST_LOG=1 rg pattern src/",
    "/usr/bin/cat f",
    "env cat f",
  ]);
  for (const command of blocked) {
    check(`bash reader blocked — ${command}`, isFileReadingCommand(command));
  }

  const allowed = Object.freeze([
    "bun test",
    "git status && git diff --stat",
    "mkdir -p x",
    "python3 script.py",
    "echo done",
    "bun run build | tee log.txt",
    "bun test | tail -5",
    "git log | grep fix",
    "bun test 2>&1 | tail -20",
  ]);
  for (const command of allowed) {
    check(`bash runner allowed — ${command}`, !isFileReadingCommand(command));
  }

  check("bashCommandFromInput undefined", bashCommandFromInput(undefined) === undefined);
  check("bashCommandFromInput empty object", bashCommandFromInput({}) === undefined);
  check("bashCommandFromInput non-string command", bashCommandFromInput({ command: 42 }) === undefined);
  check("bashCommandFromInput string command", bashCommandFromInput({ command: "ls" }) === "ls");

  const capped = capToolResultText("x".repeat(10_000));
  check(
    "tool result over cap is capped with note",
    capped !== undefined && capped.includes("tool output capped") && capped.endsWith("llm_query_chunked / llm_query_batched.]"),
    capped?.slice(-120) ?? "undefined",
  );
  check("tool result under cap is untouched", capToolResultText("x".repeat(3_999)) === undefined);

  const sb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 10_000,
    handlers: { llmQueryBatched: async (prompts) => prompts.map(() => "unused") },
  });
  const tiny = await sb.exec('print(llm_query_chunked("data", "z" * 9000))');
  check(
    "chunked rejects prompts leaving under 1,000 chars",
    tiny.stdout.includes("Error: prompt leaves under 1,000 chars per chunk"),
    tiny.stdout.trim(),
  );
  await sb.dispose();

  const csb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 1_500,
    handlers: { llmQueryBatched: async (prompts) => prompts.map(() => "unused") },
  });
  const ceiling = await csb.exec('print(llm_query_chunked("x" * 720_000, "Q"))');
  check(
    "chunked rejects inputs needing over 500 chunks",
    ceiling.stdout.includes("Error:") && ceiling.stdout.includes("chunks would be needed"),
    ceiling.stdout.trim().slice(0, 120),
  );
  await csb.dispose();

  check(
    "native prompt mentions bash restriction",
    NATIVE_PROMPT_STATIC.includes("nor via bash") && NATIVE_PROMPT_STATIC.includes("hard-capped at 4K chars"),
  );
  check(
    "native prompt stays under 6K chars",
    NATIVE_PROMPT_STATIC.length < 6_000,
    `(${NATIVE_PROMPT_STATIC.length.toLocaleString()} chars)`,
  );

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
