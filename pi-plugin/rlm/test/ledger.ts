/**
 * Phase 2 (v5 port): TaskLedger blackboard — unit + handler + engine gates.
 * Mirrors rlm_test e2e-v2 offline gates: dup_spawn → 1 runner, echo → stub, near-dup → coalesce,
 * rlmBudget demotion, empty-inject silence.
 */

import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { createSubcallHandlers } from "../src/bridge/handlers/index.ts";
import type { Invocation, SubcallHandlerDeps } from "../src/bridge/handlers/types.ts";
import {
  contextSig,
  ECHO_STUB,
  jaccard,
  normalizePrompt,
  pathSig,
  TaskLedger,
  taskKey,
  tokenSet,
} from "../src/core/ledger.ts";
import type { RlmConfig, RlmResult } from "../src/core/types.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import type { ChatMsg, CompleteResult } from "../src/bridge/model.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { runClaimedLeaf } from "../src/bridge/handlers/llm-query.ts";
import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY, ZERO_USAGE } from "./helpers.ts";

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

// ── pure helpers ────────────────────────────────────────────────────────────────

{
  check("normalize: strips standing noise phrases", normalizePrompt("Study auth. NO EDITS.") === "study auth");
  check("normalize: folds whitespace + case", normalizePrompt("  Study   AUTH  ") === "study auth");
  const ts = tokenSet("retry_timeout retry_backoff");
  check("tokenSet: [a-z0-9_]{2,} tokens", ts.size === 2 && ts.has("retry_timeout") && ts.has("retry_backoff"));
  check("jaccard: identical → 1", jaccard(tokenSet("aa bb cc"), tokenSet("aa bb cc")) === 1);
  check("jaccard: disjoint → 0", jaccard(tokenSet("aa bb"), tokenSet("cc dd")) === 0);
  check("pathSig: sorted, dedup, slash-normalized", pathSig(["b/", "a", "a"]) === "a,b");
  const k1 = taskKey("rlm", "study auth", ["src/"], "m", "abc");
  const k2 = taskKey("rlm", "STUDY auth. NO EDITS.", ["src/"], "m", "abc");
  check("taskKey: canonical (noise + case fold)", k1 === k2);
  check("taskKey: different haystack → different key", k1 !== taskKey("rlm", "study auth", ["src/"], "m", "zzz"));
  check("contextSig: string context", contextSig("haystack").length === 16);
  const files = [{ path: "a.ts", content: "x" }, { path: "b.ts", content: "y" }];
  check("contextSig: packed files differ from raw string", contextSig(files) !== contextSig("haystack"));
}

// ── ledger decisions: run / exact coalesce / near-dup / echo ─────────────────────

{
  const led = new TaskLedger();
  const req = { kind: "rlm" as const, prompt: "study the auth module", paths: ["src/auth/"], depth: 1 };
  const key = taskKey("rlm", req.prompt, req.paths, "m", "");
  const d1 = led.tryClaim(req, key);
  check("claim: first is run", d1.type === "run");
  check("claim: rlmCount counts the run", led.rlmCount() === 1);

  const d2 = led.tryClaim(req, key);
  check("claim: exact duplicate coalesces", d2.type === "coalesce" && !d2.done, JSON.stringify(d2));

  // near-dup: high overlap, different wording, same paths
  const near = { ...req, prompt: "study the auth module deeply" };
  const d3 = led.tryClaim(near, taskKey("rlm", near.prompt, near.paths, "m", ""));
  check("claim: near-dup (jaccard ≥ 0.8) coalesces onto the runner", d3.type === "coalesce", JSON.stringify(d3));

  // disjoint goal → fresh run
  const other = { ...req, prompt: "profile the database query latency" };
  const d4 = led.tryClaim(other, taskKey("rlm", other.prompt, other.paths, "m", ""));
  check("claim: disjoint goal runs", d4.type === "run");

  // waiter resolves with the runner's result
  let waiter: string | undefined;
  void led.waitFor(key).then((r) => { waiter = r; });
  led.finish(key, "AUTH FINDINGS: jwt in auth.ts");
  const d5 = led.tryClaim(req, key);
  check("claim: done claim coalesces with done=true", d5.type === "coalesce" && d5.done);
  const doneWait = await led.waitFor(key);
  check("waitFor: done claim resolves with the stored result", doneWait === "AUTH FINDINGS: jwt in auth.ts");
  await new Promise((r) => setTimeout(r, 1));
  check("waitFor: inflight waiter resolved with runner result", waiter === "AUTH FINDINGS: jwt in auth.ts");

  // fail frees the key + rejects waiters
  const k6 = taskKey("rlm", "flaky task", [], "m", "");
  led.tryClaim({ kind: "rlm", prompt: "flaky task", paths: [], depth: 1 }, k6);
  let rejected = "";
  void led.waitFor(k6).catch((e: Error) => { rejected = e.message; });
  led.fail(k6, "boom");
  await new Promise((r) => setTimeout(r, 1));
  check("fail: waiter rejected", rejected === "boom");
  const d7 = led.tryClaim({ kind: "rlm", prompt: "flaky task", paths: [], depth: 1 }, k6);
  check("fail: key becomes claimable again", d7.type === "run");

  check("hits: exact/echo/near counters", led.hits().exact >= 1 && led.hits().near >= 1, JSON.stringify(led.hits()));
}

// ── ancestor echo ───────────────────────────────────────────────────────────────

{
  const led = new TaskLedger();
  led.beginRun("study the auth module and report symbols");
  const child = { kind: "rlm" as const, prompt: "study the auth module and report symbols", paths: [], depth: 1 };
  const d = led.tryClaim(child, taskKey("rlm", child.prompt, [], "m", ""));
  check("echo: child restating the root task is rejected", d.type === "echo", JSON.stringify(d));
  const paraphrase = { ...child, prompt: "Study the AUTH module and report symbols!" };
  const d2 = led.tryClaim(paraphrase, taskKey("rlm", paraphrase.prompt, [], "m", ""));
  check("echo: paraphrased restatement also rejected", d2.type === "echo");
  const disjoint = { ...child, prompt: "benchmark the retry backoff loop" };
  const d3 = led.tryClaim(disjoint, taskKey("rlm", disjoint.prompt, [], "m", ""));
  check("echo: disjoint child still runs", d3.type === "run");
  led.endRun();
}

// ── injectBlock / listClaims ────────────────────────────────────────────────────

{
  const led = new TaskLedger();
  check("inject: empty ledger is silent (\"\")", led.injectBlock() === "");
  check("listClaims: empty ledger message", led.listClaims().includes("no claims"));
  led.beginRun("root");
  const key = taskKey("rlm", "study auth", ["src/auth/"], "m", "");
  led.tryClaim({ kind: "rlm", prompt: "study auth", paths: ["src/auth/"], depth: 1 }, key);
  const block = led.injectBlock();
  check("inject: [ledger] header + counts", block.startsWith("[ledger]") && block.includes("inflight=1"));
  check("inject: doctrine line present", block.includes("ancestor echo is rejected"));
  check("inject: paths listed", block.includes("paths=src/auth"));
  led.finish(key, "done-answer");
  const doneBlock = led.injectBlock();
  check("inject: done section after finish", doneBlock.includes("done:") && doneBlock.includes("inflight=0"));
  check("listClaims: table lists the claim", led.listClaims().includes("rlm done"));
  led.endRun();
}

// ── handler level: dup_spawn → one runner; demotion; echo stub ──────────────────

{
  const emitter = new RlmEmitter();
  const ledger = new TaskLedger();
  let childRuns = 0;
  const inv: Invocation = {
    emitter,
    parentId: undefined,
    depth: 0,
    limits: {
      remainingTimeoutMs: () => undefined,
      addUsage: () => {},
      addRaw: () => {},
    },
  };
  const config = { maxPromptChars: 100_000, maxDepth: 4, enableLedger: true, rlmBudget: 2 };
  const deps: SubcallHandlerDeps = {
    resolve: () => inv,
    gates: createSubcallGates(4, 2),
    registry: MOCK_REGISTRY,
    getLlmModel: () => MOCK_MODEL,
    getConfig: () => config,
    getModel: () => MOCK_MODEL,
    runChild: async (input): Promise<RlmResult> => {
      childRuns++;
      await new Promise((r) => setTimeout(r, 40));
      return { answer: `child-${input.rootPrompt.slice(0, 6)}`, iterations: 1, costUsd: 0, inputTokens: 5, outputTokens: 5, durationMs: 1 };
    },
    ledger,
  };
  const handlers = createSubcallHandlers(deps);

  // Two identical rlm_query spawns → ONE child engine, both answers identical.
  const s1 = await handlers.rlmQuery("study the ledger module", 0, { detached: false });
  const s2 = await handlers.rlmQuery("study the ledger module", 0, { detached: false });
  const [a1, a2] = await Promise.all([
    handlers.awaitTask(s1.task_id ?? "", undefined, undefined, 0, { detached: false }).then((r) => String((r as { result?: string }).result ?? "")),
    handlers.awaitTask(s2.task_id ?? "", undefined, undefined, 0, { detached: false }).then((r) => String((r as { result?: string }).result ?? "")),
  ]);
  check("dup_spawn: one runner for identical tasks", childRuns === 1, `childRuns=${childRuns}`);
  check("dup_spawn: both awaiters got the same answer", a1 === a2 && a1.startsWith("child-"), `${a1} | ${a2}`);

  // Ancestor echo → stub (no runner).
  ledger.beginRun("study the payment flow end to end");
  const echoRes = await handlers.rlmQuery("study the payment flow end to end", 0, { detached: false });
  const echoOut = await handlers.awaitTask(echoRes.task_id ?? "", undefined, undefined, 0, { detached: false })
    .then((r) => String((r as { result?: string }).result ?? ""));
  check("echo: handler returns the stub", echoOut === ECHO_STUB, echoOut.slice(0, 40));
  check("echo: no engine ran for the echo", childRuns === 1, `childRuns=${childRuns}`);

  // rlmBudget demotion: budget 2, one run already made → next two demote to the leaf path.
  const d1 = await handlers.rlmQuery("study module one architecture", 0, { detached: false });
  check("demotion: within budget still spawns rlm", d1.kind === "rlm", d1.kind);
  const d2 = await handlers.rlmQuery("study module two architecture", 0, { detached: false });
  const d3 = await handlers.rlmQuery("study module three architecture", 0, { detached: false });
  check("demotion: past budget the spawn kind becomes llm", d2.kind === "llm" || d3.kind === "llm", `${d2.kind}/${d3.kind}`);
  ledger.endRun();
}

// ── engine level: [ledger] injection + list_claims() over a real sandbox ────────

{
  const ledger = new TaskLedger();
  ledger.beginRun("root task");
  const key = taskKey("rlm", "prior study", ["src/"], "m", "");
  ledger.tryClaim({ kind: "rlm", prompt: "prior study", paths: ["src/"], depth: 1 }, key);
  ledger.finish(key, "prior answer");

  const config: RlmConfig = { ...DEFAULT_CONFIG, maxIterations: 3 };
  const seen: ChatMsg[][] = [];
  let calls = 0;
  const script = async (msgs: readonly ChatMsg[]): Promise<CompleteResult> => {
    calls++;
    seen.push([...msgs]);
    if (calls === 1) {
      return { text: "```python\nprint(list_claims())\n```", usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 } };
    }
    return { text: '```repl\nanswer["content"] = "ok-ledger"\nanswer["ready"] = True\n```', usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 } };
  };
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
  });
  const out = await engine({ rootPrompt: "ledger engine test", context: "ctx", depth: 0, ledger });
  check("engine: run completes with the ledger wired", out.answer === "ok-ledger", out.answer.slice(0, 40));
  check("engine: [ledger] block injected into the turn prompt",
    seen.some((msgs) => msgs.some((m) => m.content.includes("[ledger]") && m.content.includes("prior"))));
  ledger.endRun();
}

{
  // Sandbox surface: list_claims() is callable, RESERVED-filtered, and reaches the host handler.
  let hostCalls = 0;
  const sb = await PythonSandbox.spawn({
    depth: 0,
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 100_000,
    handlers: {
      llmQuery: async () => "x",
      ledgerClaims: async () => {
        hostCalls++;
        return "[ledger]\n  inflight=0 done=1";
      },
    },
  });
  try {
    const r = await sb.exec("print(list_claims())");
    check("sandbox: list_claims() callable", !r.raised && r.stdout.includes("inflight=0 done=1"), r.stdout.trim().slice(0, 60));
    check("sandbox: host ledgerClaims served", hostCalls === 1, `hostCalls=${hostCalls}`);
    const v = await sb.exec("x = 1\nprint(x)");
    check("sandbox: list_claims is RESERVED (not a user var)", !v.varNames.includes("list_claims"), JSON.stringify(v.varNames));
  } finally {
    await sb.dispose();
  }
}

// ── audit H1/H4: bounded waits + running lifecycle ───────────────────────────────

{
  const led = new TaskLedger();
  const k = taskKey("rlm", "slow runner", [], "m", "");
  led.tryClaim({ kind: "rlm", prompt: "slow runner", paths: [], depth: 1 }, k);
  led.markRunning(k);
  check("H4: markRunning flips pending → running", led.listClaims().includes("running"));
  const t0 = Date.now();
  const timedOut = await led.waitFor(k, 50).then(() => false, (e: Error) => e.message.includes("timeout"));
  check("H1: waitFor times out instead of parking forever", timedOut && Date.now() - t0 < 2_000, `${Date.now() - t0}ms`);
  // A late waiter on an ERRORED claim rejects immediately.
  led.fail(k, "runner died");
  const rejected = await led.waitFor(k).then(() => "", (e: Error) => e.message);
  check("H1: waitFor on errored claim rejects", rejected.includes("failed"), rejected);
  // The errored key is claimable again by a new runner.
  const again = led.tryClaim({ kind: "rlm", prompt: "slow runner", paths: [], depth: 1 }, k);
  check("H1: errored key re-claimable", again.type === "run");
}

// ── audit C2: exactly ONE subcall node per rlm_query (no ghost sibling) ──────────

{
  const emitter = new RlmEmitter();
  const ledger = new TaskLedger();
  let created = 0;
  emitter.onSubcallCreated((e) => {
    if (e.kind === "rlm") created++;
  });
  const inv: Invocation = {
    emitter, parentId: undefined, depth: 0,
    limits: { remainingTimeoutMs: () => undefined, addUsage: () => {}, addRaw: () => {} },
  };
  const deps: SubcallHandlerDeps = {
    resolve: () => inv,
    gates: createSubcallGates(4, 2),
    registry: MOCK_REGISTRY,
    getLlmModel: () => MOCK_MODEL,
    getConfig: () => ({ maxPromptChars: 100_000, maxDepth: 4, enableLedger: true }),
    getModel: () => MOCK_MODEL,
    runChild: async (input): Promise<RlmResult> => ({
      answer: `ran:${input.rootPrompt.slice(0, 8)}`, iterations: 1, costUsd: 0, inputTokens: 1, outputTokens: 1, durationMs: 1,
    }),
    ledger,
  };
  const handlers = createSubcallHandlers(deps);
  const s = await handlers.rlmQuery("one node per child run please", 0, { detached: false });
  await handlers.awaitTask(s.task_id ?? "", undefined, undefined, 0, { detached: false });
  check("C2: one rlm_query → exactly one created node", created === 1, `created=${created}`);

  // Echo path also emits exactly one (the decision node), never a second.
  ledger.beginRun("a very specific ancestor goal about payments");
  const s2 = await handlers.rlmQuery("a very specific ancestor goal about payments", 0, { detached: false });
  await handlers.awaitTask(s2.task_id ?? "", undefined, undefined, 0, { detached: false });
  check("C2: echo rlm_query → still exactly one node", created === 2, `created=${created}`);
  ledger.endRun();
}

// ── audit H3: batch-item claim routing (runClaimedLeaf) ─────────────────────────

{
  let execs = 0;
  const led = new TaskLedger();
  const key = taskKey("llm", "same prompt twice", [], "m", "");
  const exec = async (): Promise<string> => {
    execs++;
    await new Promise((r) => setTimeout(r, 30));
    return "LEAF-RESULT";
  };
  const [a, b] = await Promise.all([
    runClaimedLeaf(led, key, "same prompt twice", 0, exec),
    runClaimedLeaf(led, key, "same prompt twice", 0, exec),
  ]);
  check("H3: duplicate leaf prompts execute once", execs === 1, `execs=${execs}`);
  check("H3: both callers get the same result", a === b && a === "LEAF-RESULT");
  const c = await runClaimedLeaf(led, key, "same prompt twice", 0, exec);
  check("H3: a THIRD caller after done replays the stored claim", c === "LEAF-RESULT" && execs === 1);
}

// ── audit C3 (native shape): a child restating the turn CELL is stubbed ─────────

{
  const led = new TaskLedger();
  const cell = 't = rlm_query("study the flaky retry integration end to end")';
  led.beginRun(cell); // what repl-tool.execute now does around each native turn
  const child = { kind: "rlm" as const, prompt: cell, paths: [] as readonly string[], depth: 1 };
  const d = led.tryClaim(child, taskKey("rlm", cell, [], "m", ""));
  check("C3: child restating the native cell verbatim is rejected", d.type === "echo", JSON.stringify(d));
  led.endRun();
}

finish();
