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
  const handlers = createRlmHandlers({ run, llm, maxDepth: 2, maxConcurrent: 2 });

  // depth 0 -> child depth 1 < 2 -> recurse into engine
  log("rlm_query at depth 0 recurses", (await handlers.rlmQuery("alpha", null, 0)).startsWith("child("));
  // depth 1 -> child depth 2 >= maxDepth -> fall back to llm_query
  const atCap = await handlers.rlmQuery("beta", null, 1);
  log("rlm_query at depth cap falls back to llm_query", atCap.startsWith("llm("));
  // batched preserves order
  const batched = await handlers.rlmQueryBatched(["one", "two", "three"], null, 0);
  log("rlm_query_batched preserves order", batched.length === 3 && batched[0]!.includes("one") && batched[2]!.includes("three"));

  return pass;
}

function pick(reg: ModelRegistry, provider: string, id: string): Model<Api> | undefined {
  return reg.getAvailable().find((m) => m.provider === provider && m.id === id);
}

async function main() {
  const recursionOk = await testRecursionBridge();
  if (!recursionOk) process.exit(1);

  const authStorage = AuthStorage.create();
  const registry = MR.create(authStorage);
  const available = registry.getAvailable();
  if (process.env.RLM_TEST_LIVE !== "1") {
    console.log(`\navailable models: ${available.length}. Set RLM_TEST_LIVE=1 to run the engine live.`);
    return;
  }
  if (available.length === 0) {
    console.error("no models available");
    process.exit(1);
  }

  const smart = pick(registry, "deepseek", "deepseek-v4-pro") ?? available[0]!;
  const worker = pick(registry, "deepseek", "deepseek-v4-flash") ?? cheapestModel(registry)!;
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
