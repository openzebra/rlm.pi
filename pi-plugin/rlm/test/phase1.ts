/**
 * Phase 1 verification — drives PythonSandbox directly (no pi, no real LLM).
 * Run: bun run pi-plugin/rlm/test/phase1.ts
 */

import { RlmController } from "../src/mode/rlm-mode.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { loadSettings, mergeConfig, saveSettings } from "../src/config/settings.ts";
import { turnHadError } from "../src/core/answer.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { buildMetadataLine, buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { findReplBlocks, truncateOutput } from "../src/text/parsing.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Set a provider key BEFORE spawning, to prove the sandbox env is sanitized.
  process.env.ANTHROPIC_API_KEY = "sk-should-not-be-visible";
  process.env.OPENAI_API_KEY = "sk-also-hidden";

  // parsing
  const blocks = findReplBlocks("think\n```repl\nprint(1)\n```\nmore\n```repl\nx=2\n```");
  check("findReplBlocks extracts 2 blocks", blocks.length === 2, JSON.stringify(blocks));
  check("truncateOutput elides", truncateOutput("a".repeat(100), 40).includes("elided"));
  const sp = buildRlmSystemPrompt(
    { contextType: "json", contextChars: 5000 },
    { orchestrator: true },
  );
  check("prompt describes context as JSON array", sp.includes("list[dict]") && sp.includes("path"));
  check("prompt shows chunking example", sp.includes("chunk_size") && sp.includes("llm_query_batched"));
  check("prompt includes batched delegation idiom", sp.includes("llm_query_batched(["));
  const metadata = buildMetadataLine({ contextType: "json", contextChars: 5000 });
  check(
    "metadata describes JSON array context",
    metadata.includes("JSON array") && metadata.includes('"path"') && metadata.includes('"content"') && metadata.includes('"tokens"'),
  );

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
  await sandbox.exec("def f():\n    return x");
  await sandbox.exec("x = 5");
  r = await sandbox.exec("print(f())");
  check("functions see variables created in later cells", r.stdout.trim() === "5", r.stdout.trim());
  await sandbox.exec("llm_query = 'clobbered'");
  r = await sandbox.exec("print(llm_query('still works'))");
  check("tools are restored after clobber", r.stdout.includes("STUB(still works"), r.stdout.trim());

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
  r = await sandbox.exec("answer['content'] = 'draft partial'");
  check("answer content is exposed before ready", r.answerContent === "draft partial", r.answerContent);
  r = await sandbox.exec("answer['content'] = '42'; answer['ready'] = True");
  check("answer.ready surfaces final answer", r.finalAnswer === "42", String(r.finalAnswer));

  // stderr on error
  r = await sandbox.exec("import sys; print('progress warning', file=sys.stderr)");
  check("plain stderr is not a raised error", r.stderr.includes("progress warning") && !turnHadError([r]), r.stderr.trim());
  r = await sandbox.exec("1/0");
  check("error captured in stderr", r.stderr.includes("ZeroDivisionError") && turnHadError([r]), r.stderr.trim().slice(0, 60));

  // per-block timeout -> watchdog/SIGALRM kills the block (not the whole process)
  r = await sandbox.exec("while True:\n    pass");
  check("infinite loop hits exec timeout", r.stderr.includes("timeout"), r.stderr.trim().slice(0, 80));

  // sandbox still alive after timeout
  r = await sandbox.exec("print('alive')");
  check("sandbox survives a timed-out block", r.stdout.trim() === "alive", r.stdout.trim());

  // M5: context restored from context_0 after the model clobbers it.
  r = await sandbox.exec("context = 'clobbered'");
  r = await sandbox.exec("print(type(context).__name__, len(context))");
  check("M5: context restored from context_0 after clobber", r.stdout.trim() === "list 3", r.stdout.trim());

  // H3: a slow batched sub-LLM call must NOT trip the per-cell SIGALRM (paused while blocked in _rpc).
  const slow = await PythonSandbox.spawn({
    depth: 1,
    execTimeoutS: 1,
    handlers: {
      llmQueryBatched: async (prompts) => {
        await sleep(2000);
        return prompts.map((_, i) => `SLOW${i}`);
      },
    },
  });
  r = await slow.exec("print(llm_query_batched(['a', 'b']))");
  check(
    "H3: slow batched call does not trip exec timeout",
    r.stdout.includes("SLOW0") && r.stdout.includes("SLOW1") && !r.stderr.includes("timeout"),
    r.stderr.trim().slice(0, 80),
  );
  // Local CPU is still bounded: a busy loop still times out.
  r = await slow.exec("while True:\n    pass");
  check("H3: local CPU loop still bounded by exec timeout", r.stderr.includes("timeout"), r.stderr.trim().slice(0, 80));
  await slow.dispose();

  const progressSb = await PythonSandbox.spawn({
    depth: 1,
    execTimeoutS: 0,
    requestTimeoutMs: 500,
    handlers: { llmQuery: async (prompt) => { await sleep(300); return `OK ${prompt}`; } },
  });
  r = await progressSb.exec("print(llm_query('a')); print(llm_query('b')); print(llm_query('c'))");
  check("request watchdog resets on sub-call progress", r.stdout.includes("OK a") && r.stdout.includes("OK c"), r.stderr.trim());
  await progressSb.dispose();

  const silentSb = await PythonSandbox.spawn({ depth: 1, execTimeoutS: 0, requestTimeoutMs: 100 });
  try {
    await silentSb.exec("import time; time.sleep(1)");
    check("request watchdog kills silent block", false);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check("request watchdog kills silent block", message.includes("no progress"), message);
  }
  await silentSb.dispose();

  // H4: a large (≥5MB) context loads via temp file instead of one giant JSONL line.
  const big = "x".repeat(5 * 1024 * 1024);
  const bigSb = await PythonSandbox.spawn({ depth: 1 });
  await bigSb.loadContext(big);
  r = await bigSb.exec("print(len(context))");
  check("H4: ≥5MB context loads and is readable", r.stdout.trim() === String(5 * 1024 * 1024), r.stdout.trim());
  await bigSb.dispose();

  // R2: a subprocess writing to fd 1 must not crash the protocol pump.
  const dirtySb = await PythonSandbox.spawn({ depth: 1 });
  await dirtySb.loadContext("hello");
  r = await dirtySb.exec(
    "import os, subprocess; os.write(1, b'NOT JSON\\n'); print(context)",
  );
  check("R2: non-JSON fd-1 write does not crash the pump", r.stdout.trim() === "hello", r.stderr.trim().slice(0, 80));
  await dirtySb.dispose();

  // Settings round-trip covers persisted model refs, reasoning, security, and limits.
  {
    const previous = loadSettings();
    const config = mergeConfig({
      ...DEFAULT_CONFIG,
      smartReasoning: "high",
      subSampling: { ...DEFAULT_CONFIG.subSampling, reasoning: "low" },
    });
    const saved = saveSettings({ config, smart: "test/smart", worker: "test/worker" });
    const loaded = loadSettings();
    const roundTrip = mergeConfig(loaded.config);
    check("settings save reports success", saved);
    check("settings round-trips model refs", loaded.smart === "test/smart" && loaded.worker === "test/worker");
    check("settings round-trips reasoning", roundTrip.smartReasoning === "high" && roundTrip.subSampling.reasoning === "low");
    saveSettings(previous);
  }

  // --- Controller toggle() unit test: turning OFF aborts an active run ---
  {
    const cfg = { ...DEFAULT_CONFIG, enabled: true };
    const ctrl = new RlmController(cfg);
    const fakeAbort = new AbortController();
    Object.defineProperty(ctrl, "active", { value: fakeAbort, writable: true });
    check("controller is busy after inject", ctrl.isBusy());
    const result = ctrl.toggle();        // toggles OFF → should abort
    check("toggle() returns false (OFF)", result === false);
    check("toggle() OFF aborted the run", fakeAbort.signal.aborted);
    check("controller disabled after toggle()", ctrl.enabled === false);
  }

  await sandbox.dispose();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
