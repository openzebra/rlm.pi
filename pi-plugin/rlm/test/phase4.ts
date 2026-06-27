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
import { createRlmHandlers } from "../src/bridge/rlm-query.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import type { LlmBridge } from "../src/bridge/llm-query.ts";
import type { RunRlm } from "../src/core/types.ts";
import { cheapestModel } from "../src/mode/rlm-mode.ts";

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
  const llm: LlmBridge = {
    llmQuery: async (p) => `llm(${p.slice(0, 8)})`,
    llmQueryBatched: async (ps) => ps.map((p) => `llm(${p.slice(0, 8)})`),
  };
  const handlers = createRlmHandlers({
    emitter: new RlmEmitter(), run, llm, maxDepth: 2, maxConcurrent: 2 });

  // depth 0 -> child depth 1 < 2 -> recurse into engine
  log("rlm_query at depth 0 recurses", (await handlers.rlmQuery("alpha", null, 0)).startsWith("child("));
  // depth 1 -> child depth 2 >= maxDepth -> fall back to llm_query
  const atCap = await handlers.rlmQuery("beta", null, 1);
  log("rlm_query at depth cap falls back to llm_query", atCap.startsWith("llm("));
  // batched preserves order
  const batched = await handlers.rlmQueryBatched(["one", "two", "three"], null, 0);
  const firstBatch = batched[0];
  const thirdBatch = batched[2];
  log("rlm_query_batched preserves order", batched.length === 3 && firstBatch !== undefined && thirdBatch !== undefined && firstBatch.includes("one") && thirdBatch.includes("three"));

  return pass;
}

/** Token-free: prove recursive child cost is debited from the parent's budget guard. */
async function testChildBudgetPropagation(): Promise<boolean> {
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
  const llm: LlmBridge = {
    llmQuery: async () => "",
    llmQueryBatched: async (ps) => ps.map(() => ""),
  };
  const handlers = createRlmHandlers({
    emitter: new RlmEmitter(),
    run,
    llm,
    maxDepth: 3,
    maxConcurrent: 2,
    onChildUsage: (costUsd, inputTokens, outputTokens) => {
      debitedCost += costUsd;
      debitedTokens += inputTokens + outputTokens;
    },
  });

  // Run two sequential rlm_query children; both should debit.
  await handlers.rlmQuery("alpha", null, 0);
  await handlers.rlmQuery("beta", null, 0);

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

/** Token-free: prove pre-spawn guard refuses children when budget/timeout is exhausted. */
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
  const llm: LlmBridge = {
    llmQuery: async () => "",
    llmQueryBatched: async (ps) => ps.map(() => ""),
  };

  // Budget exhausted — should NOT spawn.
  spawnCount = 0;
  const h0 = createRlmHandlers({
    emitter: new RlmEmitter(), run, llm, maxDepth: 3, maxConcurrent: 2, remainingBudget: () => ({ budgetUsd: 0 }) });
  const r0 = await h0.rlmQuery("x", null, 0);
  log("F-spawn: budget=0 refuses child spawn", r0 === "Error: budget exhausted", r0);
  log("F-spawn: no run() called when budget exhausted", spawnCount === 0, `spawned ${spawnCount}`);

  // Budget negative — should NOT spawn.
  const hNeg = createRlmHandlers({
    emitter: new RlmEmitter(), run, llm, maxDepth: 3, maxConcurrent: 2, remainingBudget: () => ({ budgetUsd: -0.5 }) });
  const rNeg = await hNeg.rlmQuery("x", null, 0);
  log("F-spawn: budget<0 refuses child spawn", rNeg === "Error: budget exhausted", rNeg);

  // Timeout exhausted — should NOT spawn.
  spawnCount = 0;
  const hT = createRlmHandlers({
    emitter: new RlmEmitter(), run, llm, maxDepth: 3, maxConcurrent: 2, remainingBudget: () => ({ timeoutMs: 0 }) });
  const rT = await hT.rlmQuery("x", null, 0);
  log("F-spawn: timeout=0 refuses child spawn", rT === "Error: timeout exhausted", rT);
  log("F-spawn: no run() called when timeout exhausted", spawnCount === 0, `spawned ${spawnCount}`);

  // Budget available — SHOULD spawn normally.
  spawnCount = 0;
  const hOk = createRlmHandlers({
    emitter: new RlmEmitter(), run, llm, maxDepth: 3, maxConcurrent: 2, remainingBudget: () => ({ budgetUsd: 1.0 }) });
  const rOk = await hOk.rlmQuery("x", null, 0);
  log("F-spawn: budget>0 spawns child normally", rOk === "ok" && spawnCount === 1, `${rOk} spawned=${spawnCount}`);

  return pass;
}

function pick(reg: ModelRegistry, provider: string, id: string): Model<Api> | undefined {
  return reg.getAvailable().find((m) => m.provider === provider && m.id === id);
}

async function main() {
  const recursionOk = await testRecursionBridge();
  if (!recursionOk) process.exit(1);

  const budgetOk = await testChildBudgetPropagation();
  if (!budgetOk) process.exit(1);

  const guardOk = await testPreSpawnGuard();
  if (!guardOk) process.exit(1);

  const authStorage = AuthStorage.create();
  const registry = MR.create(authStorage);
  const available = registry.getAvailable();
  if (available.length > 0) {
    const fallbackModel = available[0];
    const model = cheapestModel(registry) ?? fallbackModel;
    if (model === undefined) {
      console.error("no fallback model available");
      process.exit(1);
    }
    const overrideEngine = createEngine({
    emitter: new RlmEmitter(),
      smartModel: model,
      workerModel: model,
      registry,
      config: DEFAULT_CONFIG,
    });
    const badOverride = await overrideEngine({
      rootPrompt: "unused",
      context: "unused",
      depth: 0,
      smartModelOverride: "missing/model",
    });
    const ok = badOverride.answer === "Error: unknown model override 'missing/model'";
    console.log(`${ok ? "✓" : "✗"} rlm_query unknown model override returns an error`);
    if (!ok) process.exit(1);
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
    smartModel: smart,
    workerModel: worker,
    registry,
    config: { ...DEFAULT_CONFIG, maxIterations: 8, maxDepth: 2, execTimeoutS: 30 },
    limits: { maxBudgetUsd: 0.5, maxTimeoutMs: 180_000 },
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
