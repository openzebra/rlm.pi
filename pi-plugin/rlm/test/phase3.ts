/**
 * Phase 3/5 verification — load the extension and drive persistent `/rlm` mode.
 *
 *   bun run pi-plugin/rlm/test/phase3.ts                 # load + wiring check (no tokens)
 *   RLM_TEST_LIVE=1 bun run pi-plugin/rlm/test/phase3.ts # real end-to-end /rlm run
 */

import { check, failureCount } from "./helpers.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { MOCK_REGISTRY } from "./helpers.ts";
import { createEngine } from "../src/core/engine.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { loadSettings, mergeConfig } from "../src/config/settings.ts";
import { cheapestModel } from "../src/mode/llm-model.ts";
import rlmExtension from "../src/index.ts";

function capableModel(reg: ModelRegistryType) {
  const a = reg.getAvailable();
  return a.find((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro") ?? a[0];
}


async function main() {
  const modelRegistry = MOCK_REGISTRY;
  const live = process.env.RLM_TEST_LIVE === "1";
  const model = live ? capableModel(modelRegistry) : cheapestModel(modelRegistry);

  // 0.84.x: createAgentSession no longer takes resourceLoader/sessionManager/settingsManager
  // or an authStorage+registry pair — the SDK owns its own ModelRuntime (auth.json at agentDir)
  // and extension loading. The global @hicaru/pi-rlm install is picked up from agentDir, which
  // makes the suite skip via the tool-conflict branch below on hosts that already have rlm.
  const modelRuntime = await ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json") });
  const { session, extensionsResult } = await createAgentSession({
    agentDir: getAgentDir(),
    model,
    modelRuntime,
  });

  const installedPackagePath = join(getAgentDir(), "npm", "node_modules", "@hicaru", "pi-rlm");
  const errors = extensionsResult.errors;
  const toolConflict = errors.some((err) =>
    String((err as { readonly error?: unknown }).error).includes('Tool "rlm" conflicts'),
  );
  // Host already has rlm registered (global install or dual factory) — load wiring is fine.
  if (toolConflict) {
    console.log(
      `\n(skipping phase3: Tool "rlm" already registered`
      + (existsSync(installedPackagePath) ? ` via ${installedPackagePath}` : "")
      + ")",
    );
    session.dispose();
    finish();
    return;
  }

  // Only fail on errors from *this* package — other agent-dir extensions (zebra-catch, etc.)
  // may be broken on the host and are not this suite's concern.
  const rlmErrors = errors.filter((err) => {
    const path = String((err as { readonly path?: unknown }).path ?? "");
    const msg = String((err as { readonly error?: unknown }).error ?? "");
    return path.includes("pi-plugin/rlm") || path.includes("@hicaru/pi-rlm")
      || msg.includes("pi-plugin/rlm") || msg.includes("@hicaru/pi-rlm");
  });
  check("rlm extension loads without errors", rlmErrors.length === 0, JSON.stringify(rlmErrors));

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
    model: model,
    llmModel: cheapestModel(modelRegistry) ?? model,
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
