/**
 * Phase 1 verification — drives PythonSandbox directly (no pi, no real LLM).
 * Run: bun run pi-plugin/rlm/test/phase1.ts
 */

import { createFsBridge, globToRegExp } from "../src/bridge/fs-tools.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRlmContext, RlmController } from "../src/mode/rlm-mode.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { loadSettings, mergeConfig, saveSettings } from "../src/config/settings.ts";
import { turnHadError } from "../src/core/answer.ts";
import { applyAnchorEdits } from "../src/text/edits.ts";
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
    { contextType: "str", contextChars: 0, fsTools: true, projectMap: true, workspaceRoot: "/x" },
    { orchestrator: true },
  );
  check("prompt forbids dumping files", sp.includes("ORCHESTRATOR over the repository") && sp.includes("never into your own output"));
  check("prompt shows batched delegation idiom", sp.includes("llm_query_batched(["));
  check("prompt includes read_file truncation guidance", sp.includes("including `read_file`") && sp.includes("slice them and pass the slices"));
  check("prompt hides propose_edit by default", !sp.includes("propose_edit(path, old, new)"));
  const editPrompt = buildRlmSystemPrompt(
    { contextType: "str", contextChars: 0, fsTools: true, projectMap: true, workspaceRoot: "/x" },
    { orchestrator: true, edit: true },
  );
  check("prompt documents propose_edit when enabled", editPrompt.includes("propose_edit(path, old, new)") && editPrompt.includes("user's approval"));
  check("prompt documents SHOW_EDITS", editPrompt.includes("SHOW_EDITS()"));
  const metadata = buildMetadataLine({ contextType: "str", contextChars: 0, projectMap: true, workspaceRoot: "/x" });
  check(
    "metadata routes file contents through sub-LLMs",
    metadata.includes("read file CONTENTS only through llm_query/llm_query_batched") &&
      !metadata.includes("file contents are available via read_file/grep/find"),
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

  // file-backed environment tools (host-enforced workspace boundary)
  const fs = createFsBridge(process.cwd());
  const fsSb = await PythonSandbox.spawn({
    depth: 1,
    execTimeoutS: 2,
    workspaceRoot: process.cwd(),
    handlers: { readFile: fs.readFile, grep: fs.grep, find: fs.find },
  });
  r = await fsSb.exec("print(read_file('pi-plugin/rlm/README.md')[:20])");
  check("read_file reads workspace files", r.stdout.trim().length > 0 && !r.stdout.includes("Error:"), r.stdout.trim());
  r = await fsSb.exec("print(grep('RLM', 'pi-plugin/rlm/**/*.ts', 5))");
  check("grep searches workspace files", r.stdout.includes("RLM") || r.stdout.includes("(no matches)"), r.stdout.trim().slice(0, 80));
  r = await fsSb.exec("print(grep('[', None, 5))");
  check("grep reports invalid patterns as errors", r.stdout.includes("Error:"), r.stdout.trim().slice(0, 80));
  r = await fsSb.exec("print(find('pi-plugin/rlm/**/*.ts'))");
  check("find lists matching project files", r.stdout.includes("pi-plugin/rlm/src"), r.stdout.trim().slice(0, 80));
  r = await fsSb.exec("print(read_file('../../etc/passwd'))");
  check("read_file rejects workspace escape", r.stdout.includes("outside the workspace root"), r.stdout.trim());
  r = await fsSb.exec("print(read_file('definitely/missing.ts'))");
  check(
    "read_file missing-file error is relative and tidy",
    r.stdout.includes("'definitely/missing.ts' not found") && !r.stdout.includes(process.cwd()),
    r.stdout.trim(),
  );
  r = await fsSb.exec("print(propose_edit('pi-plugin/rlm/README.md', 'RLM', 'RLM'))");
  check("propose_edit is gated when handler absent", r.stdout.includes("edit tools are not enabled") && r.edits.length === 0, r.stdout.trim());
  check("globstar matches zero directories", globToRegExp("a/**/b").test("a/b") && globToRegExp("a/**/b").test("a/x/b"));

  const editRoot = await mkdtemp(join(tmpdir(), "rlm-edit-"));
  try {
    await writeFile(join(editRoot, "a.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(join(editRoot, "dup.txt"), "same\nsame\n");
    await writeFile(join(editRoot, "overlap.txt"), "abcdef\n");
    const editFs = createFsBridge(editRoot);
    const editSb = await PythonSandbox.spawn({
      depth: 0,
      execTimeoutS: 2,
      workspaceRoot: editRoot,
      handlers: { readFile: editFs.readFile, grep: editFs.grep, find: editFs.find, proposeEdit: editFs.proposeEdit },
    });
    r = await editSb.exec("print(propose_edit('a.txt', 'beta\\n', 'BETA\\n'))");
    check("propose_edit unique anchor previews ok", r.stdout.includes("ok — a.txt:2") && r.edits.length === 1, r.stdout.trim());
    r = await editSb.exec("print(propose_edit('a.txt', 'beta\\n', 'BETA\\n'))");
    check("propose_edit exact duplicate is deduped", r.stdout.includes("duplicate edit already proposed") && r.edits.length === 1, r.stdout.trim());
    r = await editSb.exec("print(SHOW_EDITS())");
    check("SHOW_EDITS reports accumulated edits", r.stdout.includes("Proposed edits: 1") && r.stdout.includes("a.txt"), r.stdout.trim());
    r = await editSb.exec("print(propose_edit('overlap.txt', 'bcd', 'BCD'))");
    check("propose_edit first overlapping candidate is accepted", r.stdout.includes("ok — overlap.txt:1") && r.edits.length === 2, r.stdout.trim());
    r = await editSb.exec("print(propose_edit('overlap.txt', 'cd', 'CD'))");
    check("propose_edit catches conflicts before apply", r.stdout.includes("overlapping edits") && r.edits.length === 2, r.stdout.trim());
    r = await editSb.exec("print(propose_edit('dup.txt', 'same\\n', 'SAME\\n'))");
    check("propose_edit duplicate anchor rejects and does not append", r.stdout.includes("anchor occurs 2×") && r.edits.length === 2, r.stdout.trim());
    r = await editSb.exec("print(propose_edit('a.txt', 'missing', 'MISSING'))");
    check("propose_edit missing anchor rejects and does not append", r.stdout.includes("anchor not found") && r.edits.length === 2, r.stdout.trim());
    const smallOut = await createFsBridge(editRoot, { limits: { ...DEFAULT_CONFIG.fsLimits, maxReadBytes: 3 } }).proposeEdit("a.txt", "alpha", "ALPHA", []);
    check("propose_edit honors maxReadBytes", smallOut.includes("exceeds the 3 byte limit"), smallOut);
    const duplicateApply = applyAnchorEdits("one\ntwo\n", "dup-apply.txt", [
      { oldText: "two\n", newText: "TWO\n" },
      { oldText: "two\n", newText: "TWO\n" },
    ]);
    check("applyAnchorEdits tolerates exact duplicate edits", duplicateApply.ok && duplicateApply.applied === 1, duplicateApply.ok ? duplicateApply.text : duplicateApply.error);
    await editSb.dispose();
  } finally {
    await rm(editRoot, { recursive: true, force: true });
  }

  const dashRoot = await mkdtemp(join(tmpdir(), "rlm-dash-"));
  try {
    await writeFile(join(dashRoot, "a.txt"), "hello\n-u literal\n");
    // If ripgrep is unavailable, the bridge falls back to git grep; make the temp tree a repo
    // so the same assertion still exercises the safe `-e pattern` path.
    execFileSync("git", ["init"], { cwd: dashRoot, stdio: "ignore" });
    execFileSync("git", ["add", "a.txt"], { cwd: dashRoot, stdio: "ignore" });
    const dashFs = createFsBridge(dashRoot);
    const dashOut = await dashFs.grep("-u", null, 20);
    check("grep treats leading-dash patterns as literals", dashOut.includes("-u literal") && !dashOut.includes("hello"), dashOut);
  } finally {
    await rm(dashRoot, { recursive: true, force: true });
  }

  const sliceRoot = await mkdtemp(join(tmpdir(), "rlm-slice-"));
  try {
    await writeFile(join(sliceRoot, "big.txt"), Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join("\n"));
    const fullOut = await createFsBridge(sliceRoot).readFile("big.txt", null, null);
    check("read_file whole-file reads are not output-capped", fullOut.length > 20_000 && !fullOut.includes("truncated to 20000 characters"), fullOut.slice(-80));
    const sliceOut = await createFsBridge(sliceRoot).readFile("big.txt", 1, 30_000);
    check("read_file slices are preview-capped", sliceOut.includes("truncated to 20000 characters"), sliceOut.slice(-80));
    const limitedOut = await createFsBridge(sliceRoot, { limits: { ...DEFAULT_CONFIG.fsLimits, maxOutputChars: 40 } }).readFile("big.txt", 1, 30_000);
    check("read_file honors configured output limit", limitedOut.includes("truncated to 40 characters"), limitedOut.slice(-80));
  } finally {
    await rm(sliceRoot, { recursive: true, force: true });
  }

  const manyFiles = Array.from({ length: 2_005 }, (_, i) => `src/file-${i}.ts`);
  const findOut = await createFsBridge(process.cwd(), { initialFiles: manyFiles }).find("src/*.ts");
  check("find marks truncated output", findOut.includes("truncated to 2000 files"), findOut.slice(-80));

  const outside = await mkdtemp(join(tmpdir(), "rlm-outside-"));
  const inside = await mkdtemp(join(tmpdir(), "rlm-inside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "SECRET");
    await symlink(outside, join(inside, "evil"));
    const evilFs = createFsBridge(inside);
    const evilSb = await PythonSandbox.spawn({
      depth: 1,
      execTimeoutS: 2,
      workspaceRoot: inside,
      handlers: { readFile: evilFs.readFile, grep: evilFs.grep, find: evilFs.find },
    });
    r = await evilSb.exec("print(read_file('evil/secret.txt'))");
    check("read_file rejects symlink workspace escape", r.stdout.includes("outside the workspace root"), r.stdout.trim());
    const unsafeFs = createFsBridge(inside, { allowReadOutsideWorkspace: true });
    const unsafeOut = await unsafeFs.readFile("evil/secret.txt", null, null);
    check("read_file can allow workspace escape when configured", unsafeOut.trim() === "SECRET", unsafeOut.trim());
    await evilSb.dispose();
  } finally {
    await rm(inside, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
  await fsSb.dispose();

  const manifest = await prepareRlmContext("", process.cwd());
  check("empty context becomes project manifest", typeof manifest === "string" && manifest.startsWith("# Project map"), String(manifest).slice(0, 80));
  const explicitContext = await prepareRlmContext("explicit", process.cwd());
  check("explicit context is not replaced by manifest", explicitContext === "explicit", String(explicitContext));

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
      fsLimits: { ...DEFAULT_CONFIG.fsLimits, maxOutputChars: 1234 },
      allowReadOutsideWorkspace: true,
      editEnabled: true,
      editRequestApproval: "yolo",
    });
    const saved = saveSettings({ config, smart: "test/smart", worker: "test/worker" });
    const loaded = loadSettings();
    const roundTrip = mergeConfig(loaded.config);
    check("settings save reports success", saved);
    check("settings round-trips model refs", loaded.smart === "test/smart" && loaded.worker === "test/worker");
    check("settings round-trips reasoning", roundTrip.smartReasoning === "high" && roundTrip.subSampling.reasoning === "low");
    check("settings round-trips fs/security/edit knobs", roundTrip.fsLimits.maxOutputChars === 1234 && roundTrip.allowReadOutsideWorkspace && roundTrip.editEnabled && roundTrip.editRequestApproval === "yolo");
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
