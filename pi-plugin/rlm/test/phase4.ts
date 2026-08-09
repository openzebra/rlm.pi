/**
 * Phase 4 verification — drive the headless RLM engine with a real model over a multi-doc context.
 *
 *   RLM_TEST_LIVE=1 bun run pi-plugin/rlm/test/phase4.ts
 *
 * Validates: fenced ```repl``` transport, the iterate-until-answer loop, llm_query inside the
 * engine, and answer submission. Bounded to cheap models + few iterations.
 */

import { AuthStorage, type ModelRegistry, ModelRegistry as MR } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createEngine } from "../src/core/engine.ts";
import {
  createSubcallHandlers,
  limitsFromRemaining,
  type SubcallHandlers,
} from "../src/bridge/handlers/index.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import type { RlmInput, RunRlm } from "../src/core/types.ts";
import type { SubcallOpts } from "../src/sandbox/sandbox.ts";
import type { ContextFile } from "../src/context/types.ts";
import type { CompleteFn } from "../src/core/iteration.ts";
import { emptyChildResult, MOCK_MODEL, MOCK_REGISTRY, repl, ZERO_USAGE } from "./helpers.ts";

/** Every sub-call in these token-free tests is synchronous, never spawn()ed. */
const ATTACHED: SubcallOpts = { detached: false };

/** Collect SpawnResult → final string (api_v5). */
async function awaitText(
  h: SubcallHandlers,
  spawn: { readonly ok: boolean; readonly task_id: string | null; readonly error?: string },
  depth = 0,
): Promise<string> {
  if (!spawn.ok || spawn.task_id === null) return spawn.error ?? "Error: spawn failed";
  const r = await h.awaitTask(spawn.task_id, undefined, undefined, depth, ATTACHED);
  if (!r.ok) return r.error ?? "Error: await failed";
  if (r.results !== undefined) return r.results.join("\n");
  return r.result ?? "";
}

/** Collect SpawnResult → final string list (api_v5 batch). */
async function awaitList(
  h: SubcallHandlers,
  spawn: { readonly ok: boolean; readonly task_id: string | null; readonly error?: string },
  depth = 0,
): Promise<readonly string[]> {
  if (!spawn.ok || spawn.task_id === null) return [spawn.error ?? "Error: spawn failed"];
  const r = await h.awaitTask(spawn.task_id, undefined, undefined, depth, ATTACHED);
  if (r.results !== undefined) return r.results;
  if (r.result !== undefined) return [r.result];
  return [r.error ?? "Error: await failed"];
}

/** One-shot fallback used at the depth cap, standing in for a real llm_query. */
type Degrade = (prompt: string, depth: number) => Promise<string>;

/**
 * Recursion-only handlers: no registry or worker model is reachable on these paths,
 * because `degrade` covers the depth cap and leaf completions never occur.
 */
function rlmOnlyHandlers(opts: {
  run: RunRlm;
  degrade: Degrade;
  maxDepth: number;
  /** Stands in for the parent's live context; omit to test the unwired fallback. */
  childContext?: () => unknown;
  remaining?: () => { readonly timeoutMs?: number };
  onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
}): SubcallHandlers {
  const emitter = new RlmEmitter();
  const limits = limitsFromRemaining(opts.remaining);
  return createSubcallHandlers({
    resolve: (_o, depth) => ({ emitter, parentId: undefined, depth, limits }),
    gates: createSubcallGates(2),
    registry: MR.create(AuthStorage.create()),
    getLlmModel: () => {
      throw new Error("leaf completion must not be reached in the recursion tests");
    },
    getConfig: () => ({ maxPromptChars: Number.MAX_SAFE_INTEGER, maxDepth: opts.maxDepth }),
    runChild: opts.run,
    getChildContext: opts.childContext,
    degrade: opts.degrade,
    onChildUsage: opts.onChildUsage,
  });
}
import { cheapestModel } from "../src/mode/llm-model.ts";

/** Deterministic, token-free check of the recursion depth-cap + ordering logic. */
async function testRecursionBridge(): Promise<boolean> {
  let pass = true;
  const log = (n: string, ok: boolean) => {
    console.log(`${ok ? "✓" : "✗"} ${n}`);
    if (!ok) pass = false;
  };

  const calls: string[] = [];
  const run: RunRlm = async (input) => {
    calls.push(`run@${input.depth}`);
    return { answer: `child(${String(input.context).slice(0, 8)})`, iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  };
  const handlers = rlmOnlyHandlers({
    run,
    degrade: async (p) => `llm(${p.slice(0, 8)})`,
    maxDepth: 2,
  });

  // depth 0 -> child depth 1 < 2 -> recurse into engine
  const d0 = await awaitText(handlers, await handlers.rlmQuery("alpha", 0, ATTACHED));
  log("rlm_query at depth 0 recurses", d0.startsWith("child("));
  // depth 1 -> child depth 2 >= maxDepth -> fall back to llm_query
  const atCap = await awaitText(handlers, await handlers.rlmQuery("beta", 1, ATTACHED), 1);
  log("rlm_query at depth cap falls back to llm_query", atCap.startsWith("llm("));
  // batched preserves order
  const batched = await awaitList(handlers, await handlers.rlmBatch(["one", "two", "three"], 0, ATTACHED));
  const firstBatch = batched[0];
  const thirdBatch = batched[2];
  log("rlm_batch preserves order", batched.length === 3 && firstBatch !== undefined && thirdBatch !== undefined && firstBatch.includes("one") && thirdBatch.includes("three"));

  return pass;
}

/**
 * Issue #4: a child must inherit the parent's context, not receive the prompt as its world.
 * Token-free — the recording `run` never spawns a real engine.
 */
async function testContextInheritance(): Promise<boolean> {
  let pass = true;
  const log = (n: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "✓" : "✗"} ${n}${extra ? `  — ${extra}` : ""}`);
    if (!ok) pass = false;
  };

  const files: readonly ContextFile[] = Object.freeze([
    Object.freeze({ path: "lib/x-9f3a/src/a.ts", content: "alpha", tokens: 1 }),
    Object.freeze({ path: "src/auth/login.ts", content: "beta", tokens: 1 }),
    Object.freeze({ path: "README.md", content: "gamma", tokens: 1 }),
  ]);
  const degrade: Degrade = async (p) => `llm(${p.slice(0, 8)})`;

  const seen: RlmInput[] = [];
  const record: RunRlm = async (input) => {
    seen[seen.length] = input;
    return emptyChildResult();
  };

  const inherit = rlmOnlyHandlers({ run: record, degrade, maxDepth: 2, childContext: () => files });
  await awaitText(inherit, await inherit.rlmQuery("audit auth", 0, ATTACHED));
  const child = seen[0];
  log("#4: prompt becomes the child's rootPrompt", child?.rootPrompt === "audit auth");
  log("#4: child inherits the parent context by identity", child?.context === files);
  log("#4: child runs at depth 1", child?.depth === 1);

  // Regression guard: with no provider wired the old shape (prompt-as-context) must survive,
  // because a genuine text sub-task still has nothing else to be its world.
  seen.length = 0;
  const unwired = rlmOnlyHandlers({ run: record, degrade, maxDepth: 2 });
  await awaitText(unwired, await unwired.rlmQuery("plain text task", 0, ATTACHED));
  log("#4: unwired falls back to prompt-as-context", seen[0]?.context === "plain text task");

  // paths= narrows by prefix.
  seen.length = 0;
  await awaitText(inherit, await inherit.rlmQuery("only auth", 0, { detached: false, paths: ["src/auth/"] }));
  const narrowed = seen[0]?.context;
  log(
    "#4: paths= narrows the inherited context",
    Array.isArray(narrowed) && narrowed.length === 1
      && (narrowed[0] as ContextFile).path === "src/auth/login.ts",
    Array.isArray(narrowed) ? `${narrowed.length} file(s)` : typeof narrowed,
  );

  // A prefix that matches nothing must hand over everything AND say so — never blind the child.
  seen.length = 0;
  await awaitText(inherit, await inherit.rlmQuery("typo", 0, { detached: false, paths: ["src/nope/"] }));
  log("#4: unmatched paths fall back to the full context", seen[0]?.context === files);
  log(
    "#4: unmatched paths are reported in the child's prompt",
    seen[0]?.rootPrompt.includes("matched no files") === true,
  );

  // Batched children share one prefix set.
  seen.length = 0;
  await awaitList(inherit, await inherit.rlmBatch(["a", "b"], 0, { detached: false, paths: ["lib/x-9f3a/"] }));
  log(
    "#4: batched children each get the narrowed slice",
    seen.length === 2 && seen.every((s) => Array.isArray(s.context) && s.context.length === 1),
  );

  return pass;
}

/**
 * End-to-end at depth > 0: an inherited file bundle must survive RlmInput → loadContext → the
 * worker, and arrive as a real `list` the retrieval primitives can index.
 *
 * The first engine run at depth > 0 in the suite. Token-free (scripted `complete`), but it does
 * spawn a real Python sandbox — that is the point, since the bug lived in the handoff.
 */
async function testChildEngineSeesInheritedContext(): Promise<boolean> {
  let pass = true;
  const log = (n: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "✓" : "✗"} ${n}${extra ? `  — ${extra}` : ""}`);
    if (!ok) pass = false;
  };

  const files: readonly ContextFile[] = Object.freeze([
    Object.freeze({ path: "lib/x-9f3a/src/a.ts", content: "alpha alpha alpha", tokens: 3 }),
    Object.freeze({ path: "src/auth/login.ts", content: "beta", tokens: 1 }),
    Object.freeze({ path: "README.md", content: "gamma", tokens: 1 }),
  ]);

  let turn = 0;
  let systemPrompt = "";
  let replEcho = "";
  const complete: CompleteFn = async (messages) => {
    const first = messages[0];
    if (systemPrompt === "" && first !== undefined) systemPrompt = first.content;
    if (turn === 0) {
      turn += 1;
      return {
        text: repl('print("CTX", type(context).__name__, len(context), bool(search("alpha")))'),
        usage: ZERO_USAGE,
      };
    }
    // Turn 2 sees turn 1's REPL stdout folded into the history as a user message.
    replEcho = messages.map((m) => m.content).join("\n");
    return { text: repl('answer["content"] = "ok"\nanswer["ready"] = True'), usage: ZERO_USAGE };
  };

  const res = await createEngine({
    emitter: new RlmEmitter(),
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config: { ...DEFAULT_CONFIG, maxIterations: 4, compaction: false },
    complete,
  })({ rootPrompt: "what is alpha?", context: files, depth: 1, parentNodeId: "n1" });

  log("#4 e2e: child engine completed", res.answer === "ok", res.answer.slice(0, 80));
  // Match the stdout line, not the assistant's echo of the code that produced it.
  const ctxLine = replEcho.indexOf("CTX list");
  log("#4 e2e: worker sees a list of 3 and search() hits", replEcho.includes("CTX list 3 True"),
    ctxLine === -1 ? "no CTX stdout line" : replEcho.slice(ctxLine, ctxLine + 20));
  log("#4 e2e: child prompt uses the file-bundle branch", systemPrompt.includes("list[dict]"));
  log("#4 e2e: child prompt says it is a sub-RLM", systemPrompt.includes("You are a sub-RLM"));
  log("#4 e2e: child prompt carries the question", systemPrompt.includes("what is alpha?"));

  return pass;
}

/** Token-free: prove recursive child cost is debited from the parent's guard. */
async function testChildCostPropagation(): Promise<boolean> {
  let pass = true;
  const log = (n: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "✓" : "✗"} ${n}${extra ? `  — ${extra}` : ""}`);
    if (!ok) pass = false;
  };

  let debitedCost = 0;
  let debitedTokens = 0;
  const run: RunRlm = async (input) => {
    return {
      answer: `child(${String(input.context).slice(0, 8)})`,
      iterations: 1,
      costUsd: 0.10,
      inputTokens: 500,
      outputTokens: 200,
      durationMs: 0,
    };
  };
  const handlers = rlmOnlyHandlers({
    run,
    degrade: async () => "",
    maxDepth: 3,
    onChildUsage: (costUsd, inputTokens, outputTokens) => {
      debitedCost += costUsd;
      debitedTokens += inputTokens + outputTokens;
    },
  });

  // Run two sequential rlm_query children; both should debit.
  await awaitText(handlers, await handlers.rlmQuery("alpha", 0, ATTACHED));
  await awaitText(handlers, await handlers.rlmQuery("beta", 0, ATTACHED));

  log(
    "R1b: child cost debited from parent after each rlm_query",
    Math.abs(debitedCost - 0.20) < 1e-9,
    `$${debitedCost.toFixed(4)}`,
  );
  log(
    "R1b: child tokens debited from parent",
    debitedTokens === 1400,
    `${debitedTokens}`,
  );

  return pass;
}

/** Token-free: prove pre-spawn guard refuses children when timeout is exhausted. */
async function testPreSpawnGuard(): Promise<boolean> {
  let pass = true;
  const log = (n: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "✓" : "✗"} ${n}${extra ? `  — ${extra}` : ""}`);
    if (!ok) pass = false;
  };

  let spawnCount = 0;
  const run: RunRlm = async () => {
    spawnCount++;
    return { answer: "ok", iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  };
  const degrade: Degrade = async () => "";

  // Timeout exhausted — should NOT spawn.
  spawnCount = 0;
  const hT = rlmOnlyHandlers({ run, degrade, maxDepth: 3, remaining: () => ({ timeoutMs: 0 }) });
  const rT = await awaitText(hT, await hT.rlmQuery("x", 0, ATTACHED));
  log("F-spawn: timeout=0 refuses child spawn", rT === "Error: timeout exhausted", rT);
  log("F-spawn: no run() called when timeout exhausted", spawnCount === 0, `spawned ${spawnCount}`);

  // Timeout available — SHOULD spawn normally.
  spawnCount = 0;
  const hOk = rlmOnlyHandlers({ run, degrade, maxDepth: 3, remaining: () => ({ timeoutMs: 60_000 }) });
  const rOk = await awaitText(hOk, await hOk.rlmQuery("x", 0, ATTACHED));
  log("F-spawn: timeout>0 spawns child normally", rOk === "ok" && spawnCount === 1, `${rOk} spawned=${spawnCount}`);

  // No remaining callback — SHOULD spawn normally (no timeout cap).
  spawnCount = 0;
  const hNone = rlmOnlyHandlers({ run, degrade, maxDepth: 3 });
  const rNone = await awaitText(hNone, await hNone.rlmQuery("x", 0, ATTACHED));
  log("F-spawn: no timeout cap spawns child normally", rNone === "ok" && spawnCount === 1, `${rNone} spawned=${spawnCount}`);

  return pass;
}

function pick(reg: ModelRegistry, provider: string, id: string): Model<Api> | undefined {
  return reg.getAvailable().find((m) => m.provider === provider && m.id === id);
}

async function main() {
  const recursionOk = await testRecursionBridge();
  if (!recursionOk) process.exit(1);

  const inheritOk = await testContextInheritance();
  if (!inheritOk) process.exit(1);

  const childEngineOk = await testChildEngineSeesInheritedContext();
  if (!childEngineOk) process.exit(1);

  const costOk = await testChildCostPropagation();
  if (!costOk) process.exit(1);

  const guardOk = await testPreSpawnGuard();
  if (!guardOk) process.exit(1);

  const authStorage = AuthStorage.create();
  const registry = MR.create(authStorage);
  const available = registry.getAvailable();
  if (available.length > 0) {
    const fallbackModel = available[0];
    const guardedLlm = createSubcallHandlers({
      resolve: () => ({
        emitter: new RlmEmitter(),
        parentId: undefined,
        depth: 0,
        limits: limitsFromRemaining(() => ({ timeoutMs: 0 })),
      }),
      gates: createSubcallGates(2),
      registry,
      getLlmModel: () => fallbackModel,
      getConfig: () => ({ maxPromptChars: 400_000, maxDepth: 0 }),
    });
    const guardedOut = await awaitText(
      guardedLlm,
      await guardedLlm.llmQuery("must not call provider", 0, ATTACHED),
    );
    const guardedOk = guardedOut === "Error: timeout exhausted";
    console.log(`${guardedOk ? "✓" : "✗"} F4: llm_query refuses exhausted timeout before completion`);
    if (!guardedOk) process.exit(1);
  }
  if (process.env.RLM_TEST_LIVE !== "1") {
    console.log(`\navailable models: ${available.length}. Set RLM_TEST_LIVE=1 to run the engine live.`);
    return;
  }
  if (available.length === 0) {
    console.error("no models available");
    process.exit(1);
  }

  const fallbackSmart = available[0];
  const smart = pick(registry, "deepseek", "deepseek-v4-pro") ?? fallbackSmart;
  const worker = pick(registry, "deepseek", "deepseek-v4-flash") ?? cheapestModel(registry) ?? smart;
  if (smart === undefined || worker === undefined) {
    console.error("no models available");
    process.exit(1);
  }
  console.log(`smart=${smart.provider}/${smart.id}  worker=${worker.provider}/${worker.id}`);

  // 20 short "documents"; exactly one carries the needle.
  const docs = Array.from({ length: 20 }, (_, i) =>
    i === 13
      ? `Memo ${i}: After review, the vault access code was finalized as MARTINI-7. Keep confidential.`
      : `Memo ${i}: Routine status update. Nothing notable to report in this section.`,
  );

  let rootUsd = 0;
  let subUsd = 0;
  const engine = createEngine({
    emitter: new RlmEmitter(),
    model: smart,
    llmModel: worker,
    registry,
    config: { ...DEFAULT_CONFIG, maxIterations: 8, maxDepth: 2, execTimeoutS: 30 },
    limits: { maxTimeoutMs: 180_000 },
    onUsage: (u, role) => {
      if (role === "root") rootUsd += u.cost.total;
      else subUsd += u.cost.total;
    },
  });

  const t0 = Date.now();
  const res = await engine({
    rootPrompt: "What is the vault access code mentioned in the memos? Answer with just the code.",
    context: docs,
    depth: 0,
  });
  console.log(`\nanswer: ${JSON.stringify(res.answer.slice(0, 200))}`);
  console.log(`iterations=${res.iterations} cost=$${(rootUsd + subUsd).toFixed(5)} (root $${rootUsd.toFixed(5)}, sub $${subUsd.toFixed(5)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const ok = /MARTINI-7/i.test(res.answer);
  console.log(ok ? "\n✓ engine solved the needle-in-haystack task" : "\n✗ wrong answer");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
