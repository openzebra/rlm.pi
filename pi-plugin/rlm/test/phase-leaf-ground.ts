/**
 * SKILL.state Workstream D — leaf-call grounding: groundLeafPrompt attaches/omits per the
 * score threshold (byte-identical below it), and completeDeps projects the seam verbatim
 * (DRY #1 — complete1 applies it once for every leaf path).
 * Run: bun run pi-plugin/rlm/test/phase-leaf-ground.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groundLeafPrompt, SkillStore } from "../src/config/skillstate.ts";
import { completeDeps } from "../src/bridge/handlers/completion.ts";
import type { SubcallHandlerDeps } from "../src/bridge/handlers/types.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import { check, finish, MOCK_MODEL, MOCK_REGISTRY } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "rlm-leaf-ground-"));
const PROMPT = "where does settingsPath live and what does it return?";

function baseDeps(groundLeaf?: (p: string) => string): SubcallHandlerDeps {
  return {
    resolve: () => null,
    gates: createSubcallGates(2),
    registry: MOCK_REGISTRY,
    getLlmModel: () => MOCK_MODEL,
    getConfig: () => ({ maxPromptChars: 400_000, maxDepth: 4, requestTimeoutMs: 900_000 }),
    ...(groundLeaf === undefined ? {} : { groundLeaf }),
  };
}

async function main(): Promise<void> {
  try {
    const store = await SkillStore.hydrate(8, tmp);
    store.merge([
      { text: "config/settings.ts:22 — settingsPath() joins getAgentDir() with rlm.json", keywords: ["settingspath"], tags: ["config"] },
      { text: "src/util/retry.ts — retryPolicy() builds the backoff ladder", keywords: ["retrypolicy"], tags: ["symbol"] },
    ]);

    const config = { skillStateLeafTokens: 200, skillStateMinScore: 1.0 };

    // ── attachment above threshold ──
    const grounded = groundLeafPrompt(store, config, PROMPT);
    check("grounding prefix added", grounded.startsWith("[Project facts]\n"));
    check("matched note included", grounded.includes("settingsPath"));
    check("original prompt preserved at the end", grounded.endsWith(`\n\n${PROMPT}`));

    // ── byte-identical below threshold ──
    const gibberish = "zzzqqq entirely wwwwxxxzz xyzzzy";
    const miss = groundLeafPrompt(store, config, gibberish);
    check("below threshold ⇒ byte-identical", miss === gibberish);
    const strict = groundLeafPrompt(store, { skillStateLeafTokens: 200, skillStateMinScore: 1e9 }, PROMPT);
    check("huge threshold ⇒ byte-identical", strict === PROMPT);
    const tiny = groundLeafPrompt(store, { skillStateLeafTokens: 0, skillStateMinScore: 0 }, PROMPT);
    check("zero budget ⇒ byte-identical", tiny === PROMPT);

    // ── budget respected ──
    const small = groundLeafPrompt(store, { skillStateLeafTokens: 30, skillStateMinScore: 0 }, PROMPT);
    check("budget caps the slice", small.length < 30 * 4 + PROMPT.length + 40, String(small.length));

    // ── DRY #1 projection: completeDeps carries the seam verbatim ──
    const groundLeaf = (p: string): string => groundLeafPrompt(store, config, p);
    check("completeDeps projects groundLeaf", completeDeps(baseDeps(groundLeaf)).groundLeaf === groundLeaf);
    check("absent seam stays absent", completeDeps(baseDeps()).groundLeaf === undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  finish();
}

void main(); // explicit: fire-and-forget, no floating promise
