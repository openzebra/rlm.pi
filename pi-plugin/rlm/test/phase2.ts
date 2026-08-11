/**
 * Phase 2 verification — wires the real llm_query bridge to the sandbox.
 *
 * Lists available models always. Performs a real (token-spending) sub-LLM call only when
 * RLM_TEST_LIVE=1. Run: RLM_TEST_LIVE=1 bun run pi-plugin/rlm/test/phase2.ts
 */

import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { MOCK_REGISTRY } from "./helpers.ts";
import {
  createSubcallHandlers,
  limitsFromRemaining,
} from "../src/bridge/handlers/index.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

async function main() {
  const registry = MOCK_REGISTRY;
  const models = registry.getAvailable();
  console.log(`available models: ${models.length}`);
  for (const m of models.slice(0, 8)) console.log(`  - ${m.provider}/${m.id}`);

  if (process.env.RLM_TEST_LIVE !== "1") {
    console.log("\n(skipping live call; set RLM_TEST_LIVE=1 to run a real sub-LLM query)");
    return;
  }
  if (models.length === 0) {
    console.log("\nNo models with configured auth — cannot run live test.");
    process.exit(1);
  }

  const worker = models[0];
  if (worker === undefined) {
    console.log("\nNo worker model available.");
    process.exit(1);
  }
  console.log(`\nworker model: ${worker.provider}/${worker.id}`);
  let totalCost = 0;
  const invocation = {
    emitter: new RlmEmitter(),
    parentId: undefined,
    depth: 0,
    limits: limitsFromRemaining(),
  };
  const bridge = createSubcallHandlers({
    resolve: () => invocation,
    gates: createSubcallGates(4),
    registry,
    getLlmModel: () => worker,
    getConfig: () => ({ maxPromptChars: 400_000, maxDepth: 0, subSampling: { maxTokens: 32 } }),
    onUsage: (u) => {
      totalCost += u.cost.total;
    },
  });

  const sandbox = await PythonSandbox.spawn({ depth: 1, handlers: bridge });
  await sandbox.loadContext("The capital of France is Paris. The capital of Japan is Tokyo.");
  const r = await sandbox.exec(
    "ans = llm_query('Using only this text, what is the capital of Japan? One word.\\n' + context)\nprint('GOT:', ans)",
  );
  console.log(r.stdout.trim());
  if (r.stderr.trim()) console.log("stderr:", r.stderr.trim().slice(0, 200));
  const ok = /tokyo/i.test(r.stdout);
  console.log(ok ? "✓ live llm_query works" : "✗ unexpected answer");
  console.log(`approx cost: $${totalCost.toFixed(6)}`);
  await sandbox.dispose();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
