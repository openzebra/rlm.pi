/**
 * Phase-guards verification — native-mode bash steering/capping, prompt budget, and
 * llm_query_chunked guardrails.
 * Run: bun run pi-plugin/rlm/test/phase-guards.ts
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { NATIVE_PROMPT_STATIC, NATIVE_PROMPT_BUDGET, NATIVE_TURN_REMINDER } from "../src/prompts/native.ts";
import { formatContextListing } from "../src/context/listing.ts";
import { buildReplResultText } from "../src/tool/repl-result.ts";
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
    check(`bash reader classified — ${command}`, isFileReadingCommand(command));
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
    capped !== undefined && capped.includes("tool output capped") && capped.endsWith("llm_query_chunked / llm_batch.]"),
    capped?.slice(-120) ?? "undefined",
  );
  check("tool result under cap is untouched", capToolResultText("x".repeat(3_999)) === undefined);

  const sb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 10_000,
    handlers: { llmBatch: async (prompts) => prompts.map(() => "unused") },
  });
  const tiny = await sb.exec('print(llm_query_chunked("data", "z" * 9000))');
  check(
    "chunked rejects prompts leaving under 1,000 chars",
    tiny.stdout.includes("Error: prompt leaves under 1,000 chars per chunk"),
    tiny.stdout.trim(),
  );

  // ── blocked builtins explain themselves ──
  // They used to be bound to None, so reaching for eval() gave a bare "'NoneType' object is not
  // callable" — indistinguishable from a corrupted namespace. An audit burned six execs on that
  // and filed a phantom bug. The message is the fix, not a line of prompt budget.
  for (const name of ["eval", "exec", "globals", "locals", "compile", "input"]) {
    const blocked = await sb.exec(`${name}("1+1")`);
    check(
      `${name}() is blocked with an explanation, not a NoneType error`,
      blocked.raised
        && blocked.stderr.includes("disabled in the RLM sandbox by design")
        && !blocked.stderr.includes("NoneType"),
      blocked.stderr.trim().split("\n").at(-1)?.slice(0, 100) ?? "",
    );
  }
  const stillCallable = await sb.exec("print(callable(llm_query), callable(search), len([1,2]))");
  check(
    "blocking does not disturb the rest of the namespace",
    stillCallable.stdout.includes("True True 2"),
    stillCallable.stdout.trim(),
  );
  await sb.dispose();

  const csb = await PythonSandbox.spawn({
    depth: 1,
    maxPromptChars: 1_500,
    handlers: { llmBatch: async (prompts) => prompts.map(() => "unused") },
  });
  const ceiling = await csb.exec('print(llm_query_chunked("x" * 720_000, "Q"))');
  check(
    "chunked rejects inputs needing over 500 chunks",
    ceiling.stdout.includes("Error:") && ceiling.stdout.includes("chunks would be needed"),
    ceiling.stdout.trim().slice(0, 120),
  );
  await csb.dispose();

  check(
    "native prompt does not mention read/grep ban or allowlist",
    !NATIVE_PROMPT_STATIC.includes("read`/`grep` are blocked")
      && !NATIVE_PROMPT_STATIC.includes("Native `read`/`grep`/bash are allowed")
      && !NATIVE_PROMPT_STATIC.includes("Native read/grep/bash allowed"),
  );
  check(
    "native prompt stays under budget",
    NATIVE_PROMPT_STATIC.length < NATIVE_PROMPT_BUDGET,
    `(${NATIVE_PROMPT_STATIC.length.toLocaleString()} chars; budget ${NATIVE_PROMPT_BUDGET.toLocaleString()})`,
  );
  check(
    "native prompt states what an rlm_query child inherits",
    NATIVE_PROMPT_STATIC.includes("child inherits your `context`")
      && NATIVE_PROMPT_STATIC.includes("paths="),
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
    (NATIVE_PROMPT_STATIC.includes("hard-capped") || NATIVE_PROMPT_STATIC.includes("hard-capped (~4K"))
      && NATIVE_PROMPT_STATIC.includes("LOCATE-THEN-DELEGATE"),
  );
  check("per-turn reminder mentions the contract", NATIVE_TURN_REMINDER.includes("llm_query_chunked"));

  // ── context listing tail no longer contradicts ──
  const listing = formatContextListing([]);
  check("formatContextListing no longer points at file-reading tools", !listing.includes("use the file-reading tools"));
  check("formatContextListing points at repl delegation", listing.includes("llm_batch"));

  // ── repl result assembly (exercises the real production function, not a hand-built concatenation) ──
  const bigStdout = "z".repeat(10_000);
  const llmSubcall = { id: "s1", depth: 0, kind: "llm" as const, label: "q", status: "done" as const, startedAt: 0, costUsd: 0, tokens: 0 };
  // Big stdout + no subcalls → stdout is capped and the zero-subcall nudge fires.
  const solo = buildReplResultText(bigStdout, undefined, []);
  check(
    "repl assembly caps stdout and nudges zero-subcall",
    solo.text.includes("repl() stdout capped") && solo.text.includes("0 sub-LLM calls"),
    solo.text.slice(-90),
  );
  check(
    "nudge carves out authoring",
    solo.text.includes("Authoring an edit body yourself is correct"),
    solo.text.slice(-120),
  );
  // A delegation subcall present → no nudge even with big stdout.
  const delegated = buildReplResultText(bigStdout, undefined, [llmSubcall]);
  check("delegation subcall suppresses the nudge", !delegated.text.includes("sub-LLM calls"));

  // ── Removed REPL surface stays removed ──
  // These were the pipeline/todo scaffold. A stale `ns[...]` binding would silently re-expose
  // a tool with no host handler behind it, so assert absence the same way smoke.ts asserts
  // `stage_edit` is gone.
  const sandbox = await PythonSandbox.spawn({
    depth: 0, execTimeoutS: 30, requestTimeoutMs: 30_000,
    python: "python3", initTimeoutMs: 30_000, maxPromptChars: 400_000,
    handlers: {},
  });
  try {
    for (const name of Object.freeze(["todo", "save_artifact", "advance_phase", "ask_user_question"])) {
      const probe = await sandbox.exec(`print(${name})`);
      check(`${name} is removed from the sandbox`, probe.raised && probe.stderr.includes("NameError"), probe.stderr.slice(0, 120));
    }
    const alive = await sandbox.exec("print(callable(llm_query), callable(search), callable(add_context))");
    check("retrieval + delegation surface intact", !alive.raised && alive.stdout.includes("True True True"), alive.stderr.slice(0, 120));
  } finally {
    await sandbox.dispose();
  }

  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
