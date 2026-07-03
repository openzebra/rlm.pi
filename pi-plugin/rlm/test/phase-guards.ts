/**
 * Phase-guards verification — native-mode bash steering/capping, prompt budget, and
 * llm_query_chunked guardrails.
 * Run: bun run pi-plugin/rlm/test/phase-guards.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { NATIVE_PROMPT_STATIC, NATIVE_PROMPT_BUDGET, NATIVE_TURN_REMINDER } from "../src/prompts/system.ts";
import { formatForLLM } from "../src/context/repomix-context.ts";
import { buildReplResultText } from "../src/tool/repl-tool.ts";
import {
  bashCommandFromInput,
  capToolResultText,
  capReplResultText,
  isFileReadingCommand,
  replDelegationNudge,
  NUDGE_STDOUT_CHARS,
  TOOL_RESULT_CAP,
} from "../src/mode/native-guards.ts";

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
    NATIVE_PROMPT_STATIC.includes("bash readers (cat/sed/head/tail/awk/rg) are blocked"),
  );
  check(
    "native prompt stays under budget",
    NATIVE_PROMPT_STATIC.length < NATIVE_PROMPT_BUDGET,
    `(${NATIVE_PROMPT_STATIC.length.toLocaleString()} chars; budget ${NATIVE_PROMPT_BUDGET.toLocaleString()})`,
  );

  // ── repl output cap ──
  const replCapped = capReplResultText("y".repeat(10_000));
  check(
    "repl stdout over cap is capped with repl note",
    replCapped !== undefined && replCapped.includes("repl() stdout capped")
      && replCapped.includes("llm_query_chunked"),
    replCapped?.slice(-120) ?? "undefined",
  );
  check("repl stdout under cap is untouched", capReplResultText("y".repeat(TOOL_RESULT_CAP)) === undefined);

  // ── delegation nudge ──
  check("nudge fires: big stdout, 0 sub-LLM calls", replDelegationNudge(5_000, false) !== undefined);
  check("no nudge: sub-LLM calls made", replDelegationNudge(5_000, true) === undefined);
  check("no nudge: small stdout", replDelegationNudge(NUDGE_STDOUT_CHARS, false) === undefined);

  // ── prompts ──
  check(
    "native prompt states repl cap + delegation rule",
    NATIVE_PROMPT_STATIC.includes("hard-capped at 4K chars")
      && NATIVE_PROMPT_STATIC.includes("DELEGATION RULE"),
  );
  check("per-turn reminder mentions the contract", NATIVE_TURN_REMINDER.includes("llm_query_chunked"));

  // ── context listing tail no longer contradicts ──
  const listing = formatForLLM({ files: [], totalFiles: 0, totalTokens: 0, totalChars: 0 });
  check("formatForLLM no longer points at file-reading tools", !listing.includes("use the file-reading tools"));
  check("formatForLLM points at repl delegation", listing.includes("llm_query_batched"));

  // ── repl result assembly (exercises the real production function, not a hand-built concatenation) ──
  const bigStdout = "z".repeat(10_000);
  const editsFixture = [{ path: "a.ts", oldText: "x", newText: "y" }];
  const llmSubcall = { id: "s1", depth: 0, kind: "llm" as const, label: "q", status: "done" as const, startedAt: 0, costUsd: 0, tokens: 0 };
  // Big stdout + no edits + no subcalls → stdout is capped and the zero-subcall nudge fires.
  const solo = buildReplResultText(bigStdout, undefined, [], false, []);
  check(
    "repl assembly caps stdout and nudges zero-subcall",
    solo.text.includes("repl() stdout capped") && solo.text.includes("0 sub-LLM calls"),
    solo.text.slice(-90),
  );
  // Big stdout + staged edits → STAGED_EDITS JSON survives capping (appended AFTER the cap).
  const staged = buildReplResultText(bigStdout, undefined, editsFixture, false, []);
  check(
    "staged edits survive stdout capping",
    staged.text.includes("STAGED_EDITS:") && staged.text.endsWith('"newText":"y"}]'),
    staged.text.slice(-80),
  );
  check("staged edits suppress the delegation nudge", !staged.text.includes("sub-LLM calls"));
  // A delegation subcall present → no nudge even with big stdout and no edits.
  const delegated = buildReplResultText(bigStdout, undefined, [], false, [llmSubcall]);
  check("delegation subcall suppresses the nudge", !delegated.text.includes("sub-LLM calls"));

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
