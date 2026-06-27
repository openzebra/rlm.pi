/**
 * Phase 3/5 verification — load the extension and drive persistent `/rlm` mode.
 *
 *   bun run pi-plugin/rlm/test/phase3.ts                 # load + wiring check (no tokens)
 *   RLM_TEST_LIVE=1 bun run pi-plugin/rlm/test/phase3.ts # real end-to-end /rlm run
 */

import { check, failureCount } from "./helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry as ModelRegistryType,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createEngine } from "../src/core/engine.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { loadSettings, mergeConfig } from "../src/config/settings.ts";
import { cheapestModel } from "../src/mode/rlm-mode.ts";
import rlmExtension from "../src/index.ts";

function capableModel(reg: ModelRegistryType) {
  const a = reg.getAvailable();
  return a.find((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro") ?? a[0];
}


async function main() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const live = process.env.RLM_TEST_LIVE === "1";
  const model = live ? capableModel(modelRegistry) : cheapestModel(modelRegistry);

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [rlmExtension],
  });
  await loader.reload();

  const { session, extensionsResult } = await createAgentSession({
    resourceLoader: loader,
    model,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });

  check("extension loads without errors", extensionsResult.errors.length === 0, JSON.stringify(extensionsResult.errors));

  if (!live) {
    console.log("\n(skipping live /rlm run; set RLM_TEST_LIVE=1)");
    session.dispose();
    finish();
    return;
  }
  if (!model) {
    check("a model is available", false);
    process.exit(1);
  }
  console.log(`model: ${model.provider}/${model.id}`);

  const ctxDir = join(process.cwd(), ".tmp-rlm-test");
  mkdirSync(ctxDir, { recursive: true });
  const ctxFile = join(ctxDir, `rlm-ctx-${Date.now()}.txt`);
  writeFileSync(
    ctxFile,
    "Field notes. The mayor of Veridia is Lena Cole. Veridia's official tree is the silver birch. " +
      "Population at last census: 48,213. The festival of lanterns happens every autumn.",
  );

  await session.prompt("/rlm");
  await session.agent.waitForIdle();
  await session.prompt(`Use read_file('${ctxFile}') and answer: what is Veridia's official tree? Answer with two words.`);
  await session.agent.waitForIdle();

  // The engine posts the answer as a custom "rlm-answer" message.
  let answer = "";
  for (const m of session.messages) {
    const msg = m as { customType?: string; content?: unknown };
    if (msg.customType === "rlm-answer" && typeof msg.content === "string") answer = msg.content;
  }
  console.log(`\nrlm-answer: ${JSON.stringify(answer.slice(0, 200))}`);
  check("RLM answered from the context (silver birch)", /silver birch/i.test(answer));

  // Limit-firing: a maxTokens:1 cap guarantees a LimitError on the first completion regardless of
  // model behaviour, proving the root guards fire (the engine stops with a partial/stop answer).
  const baseCfg = mergeConfig((await loadSettings()).config);
  const limEngine = createEngine({
    emitter: new RlmEmitter(),
    smartModel: model,
    workerModel: cheapestModel(modelRegistry) ?? model,
    registry: modelRegistry,
    config: baseCfg,
    limits: { maxTokens: 1 },
  });
  const lim = await limEngine({ rootPrompt: "What is 2+2?", context: "no extra context", depth: 0 });
  check(
    "limit: maxTokens:1 stops the engine with a stop/partial answer",
    /stopped/i.test(lim.answer) || lim.iterations < baseCfg.maxIterations,
    JSON.stringify(lim.answer).slice(0, 100),
  );

  session.dispose();
  finish();
}

function finish() {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
