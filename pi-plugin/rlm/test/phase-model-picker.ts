/**
 * phase-model-picker — grouped picker data path + status widget lines + pins.
 * Pure layers only (catalog/status/apply/settings); the overlay flow needs a
 * live terminal and stays covered by the smoke session.
 */

import { check, failureCount } from "./helpers.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildCatalog, modelRefOf, pickableModels } from "../src/ui/model-picker/grouping.ts";
import { supportedThinkingLevels } from "../src/ui/model-picker/levels.ts";
import { formatRlmStatusLines } from "../src/ui/status.ts";
import { applyLlmSelection, applyRlmSelection } from "../src/commands/pins.ts";
import { RlmController } from "../src/mode/rlm-mode.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";

// ── fixtures ──
const mk = (provider: string, id: string, reasoning = false): Model<Api> => ({
  provider, id, reasoning,
  contextWindow: 100_000,
  cost: { input: 1, output: 1 },
  thinkingLevelMap: reasoning ? { low: 1, high: 2 } : undefined,
} as unknown as Model<Api>);

// ── catalog: provider > model, counts, sorting ──
{
  const catalog = buildCatalog([
    mk("openrouter", "nvidia/nemotron-3.5-lightning:free"),
    mk("openrouter", "google/gemma-4-26b", true),
    mk("zai", "glm-5.2", true),
    mk("openrouter", "nvidia/nemotron-3.5-lightning"),
  ]);
  check("catalog: providers alphabetical", catalog.map((g) => g.provider).join(",") === "openrouter,zai");
  check("catalog: provider groups its models", catalog[0]?.models.length === 3);
  check("catalog: model ref format", catalog[0]?.models.some((m) => modelRefOf(m) === "openrouter/nvidia/nemotron-3.5-lightning:free") === true);
  check("levels: reasoning model lists its levels", supportedThinkingLevels(mk("p", "m", true)).join(",") === "low,high");
  check("levels: plain model has none", supportedThinkingLevels(mk("p", "m")).length === 0);
  check("pickableModels still exported from grouping", Array.isArray(pickableModels({ getAvailable: () => [], getAll: () => [] } as never)));
}

// ── status lines: OFF / ON / pins / tokens ──
{
  const controller = new RlmController(DEFAULT_CONFIG);
  controller.setEnabled(false);
  check("status: OFF is a single line", formatRlmStatusLines(controller).length === 1 && formatRlmStatusLines(controller)[0] === "○ RLM OFF");

  controller.setEnabled(true);
  const lines = formatRlmStatusLines(controller, { tokens: 81_900, contextWindow: 200_000, percent: 41 } as never);
  check("status: ON is three lines", lines.length === 3);
  check("status: headline", lines[0] === "● RLM ON");
  check("status: llm lane defaults cheapest", lines[1]?.includes("llm=cheapest") === true);
  check("status: rlm lane defaults session", lines[2]?.includes("rlm=session") === true);
  check("status: tokens on both lanes", lines[1]?.includes("81.9k tok") === true && lines[2]?.includes("81.9k tok") === true);

  controller.llmModel = mk("openrouter", "nvidia/nemotron-3.5-lightning:free");
  controller.rlmModel = mk("zai", "glm-5.2");
  const pinned = formatRlmStatusLines(controller, { tokens: null, contextWindow: 1, percent: null } as never);
  check("status: pinned llm shown", pinned[1]?.includes("llm=openrouter/nvidia/nemotron-3.5-lightning:free") === true);
  check("status: pinned rlm shown", pinned[2]?.includes("rlm=zai/glm-5.2") === true);
  check("status: null tokens hide suffix", !pinned[1]?.includes("tok"));
}

// ── pins: apply selection state machine ──
{
  const controller = new RlmController(DEFAULT_CONFIG);
  applyLlmSelection(controller, undefined);
  check("pins: esc is a no-op", controller.llmModel === undefined && controller.config.subSampling.reasoning === undefined);
  applyLlmSelection(controller, { model: mk("openrouter", "gemma-4"), thinkingLevel: "high" });
  check("pins: llm model + subSampling reasoning", controller.savedLlmRef === "openrouter/gemma-4" && controller.config.subSampling.reasoning === "high");
  applyLlmSelection(controller, null);
  check("pins: cheapest clears pin", controller.llmModel === undefined && controller.explicitClearPin === true);

  applyRlmSelection(controller, { model: mk("zai", "glm-5.2", true), thinkingLevel: "low" });
  check("pins: rlm model + rootSampling reasoning", controller.rlmModel !== undefined && controller.savedRlmRef === "zai/glm-5.2" && controller.config.rootSampling?.reasoning === "low");
  applyRlmSelection(controller, null);
  check("pins: session clears rlm pin", controller.rlmModel === undefined && controller.explicitClearRlmPin === true);
}

// ── resolveModels: the rlm pin overrides the session model ──
{
  const controller = new RlmController(DEFAULT_CONFIG);
  const ctx = {
    model: mk("session", "active-model"),
    modelRegistry: { getAvailable: () => [mk("vendor", "cheap")], find: () => undefined },
  } as never;
  const unpinned = controller.resolveModels(ctx);
  check("resolve: unpinned follows session model", unpinned?.model.id === "active-model" && unpinned?.llm !== undefined);
  controller.rlmModel = mk("zai", "glm-5.2");
  const pinned = controller.resolveModels(ctx);
  check("resolve: rlm pin wins over session", pinned?.model.id === "glm-5.2");
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
