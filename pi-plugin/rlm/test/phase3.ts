/**
 * Phase 3/5 verification — load the extension and drive the engine-driven `/rlm` command.
 *
 *   bun run pi-plugin/rlm/test/phase3.ts                 # load + wiring check (no tokens)
 *   RLM_TEST_LIVE=1 bun run pi-plugin/rlm/test/phase3.ts # real end-to-end /rlm run
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { cheapestModel } from "../src/mode/rlm-mode.ts";
import rlmExtension from "../src/index.ts";

function capableModel(reg: ModelRegistryType) {
  const a = reg.getAvailable();
  return a.find((m) => m.provider === "deepseek" && m.id === "deepseek-v4-pro") ?? a[0];
}

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures++;
};

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

  const ctxFile = join(tmpdir(), `rlm-ctx-${Date.now()}.txt`);
  writeFileSync(
    ctxFile,
    "Field notes. The mayor of Veridia is Lena Cole. Veridia's official tree is the silver birch. " +
      "Population at last census: 48,213. The festival of lanterns happens every autumn.",
  );

  await session.prompt(`/rlm --file ${ctxFile} According to the notes, what is Veridia's official tree? Answer with two words.`);
  await session.agent.waitForIdle();

  // The engine posts the answer as a custom "rlm-answer" message.
  let answer = "";
  for (const m of session.messages) {
    const msg = m as { customType?: string; content?: unknown };
    if (msg.customType === "rlm-answer" && typeof msg.content === "string") answer = msg.content;
  }
  console.log(`\nrlm-answer: ${JSON.stringify(answer.slice(0, 200))}`);
  check("RLM answered from the context (silver birch)", /silver birch/i.test(answer));

  session.dispose();
  finish();
}

function finish() {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
