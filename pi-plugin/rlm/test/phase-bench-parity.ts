/**
 * Bench↔engine sampling parity — the bench and the interactive engine assemble sampling
 * independently; this suite pins them together so they cannot drift.
 *
 * The r3 reproducibility knobs were MEASURED through bench/engine.ts but must be REPRODUCIBLE
 * through the real engine (createEngine). benchSampling() is the bench's one sampling
 * assembly; here it is driven through the REAL createEngine with a capturing completion mock
 * (temperature 0 configured) and the wire options are asserted:
 *   - the bench's reasoning flag rides INSIDE rootSampling and therefore wins the engine's
 *     merge rule ({ reasoning: smartReasoning, ...rootSampling }) over any default;
 *   - the thinking-doubled output cap (8192 vs 4096) reaches the model call;
 *   - temperature 0 reaches the main-loop turn AND the finalize call (the finalize path once
 *     ignored rootSampling entirely — see phase-sampling.ts for that regression);
 *   - the sub sampling keeps the bench leaf shape (2048 cap, same temperature, never reasoning).
 *
 * Run: bun run pi-plugin/rlm/test/phase-bench-parity.ts
 */

import { check, captureComplete, MOCK_MODEL, MOCK_REGISTRY, repl, failureCount } from "./helpers.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { benchSampling } from "../../../bench/engine.ts";
import type { RlmConfig } from "../src/core/types.ts";

/** Build the config exactly the way bench makeRun does (minus bench-only tuning). */
function benchConfig(opts?: Parameters<typeof benchSampling>[0]): RlmConfig {
  const sampling = benchSampling(opts);
  return Object.freeze({
    ...DEFAULT_CONFIG,
    maxIterations: 2,
    enableTokenBudget: false, // bench measures capability — see bench/engine.ts
    compaction: false,
    enableLedger: false,
    rootSampling: sampling.root,
    subSampling: sampling.sub,
  });
}

function drive(config: RlmConfig, responses: readonly string[]): Promise<ReturnType<typeof captureComplete>["calls"]> {
  const { complete, calls } = captureComplete(responses);
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete,
  });
  return engine({ rootPrompt: "bench-engine parity probe", context: "ctx", depth: 0 }).then(() => calls);
}

async function main(): Promise<void> {
  const DONE = repl(`answer["content"] = "ok"\nanswer["ready"] = True`);

  // ── thinking arm (the r3 coached shape): reasoning "high", temperature 0, 8192 root cap ──
  {
    const config = benchConfig({ temperature: 0, reasoning: "high" });
    check("parity: bench root sampling frozen with reasoning", config.rootSampling.reasoning === "high" && config.rootSampling.temperature === 0 && config.rootSampling.maxTokens === 8192);
    const calls = await drive(config, [DONE]);
    const first = calls[0];
    check("parity: reasoning flag wins the engine merge (not an interactive default)", first?.opts.reasoning === "high", String(first?.opts.reasoning));
    check("parity: thinking-doubled root cap reaches the wire", first?.opts.maxTokens === 8192, String(first?.opts.maxTokens));
    check("parity: temperature 0 reaches the wire", first?.opts.temperature === 0, String(first?.opts.temperature));
  }

  // ── finalize parity: the LAST model call must carry the bench sampling too ──
  {
    const calls = await drive(benchConfig({ temperature: 0, reasoning: "high" }), [repl(`print("not done")`), "final text"]);
    const finalizeCall = calls[1];
    check("parity: finalize carries temperature 0", finalizeCall?.opts.temperature === 0, String(finalizeCall?.opts.temperature));
    check("parity: finalize carries the thinking-doubled cap", finalizeCall?.opts.maxTokens === 8192, String(finalizeCall?.opts.maxTokens));
    check("parity: finalize carries the bench reasoning", finalizeCall?.opts.reasoning === "high", String(finalizeCall?.opts.reasoning));
  }

  // ── no-reasoning arm: 4096 cap, no reasoning anywhere ──
  {
    const config = benchConfig({ temperature: 0 });
    check("parity: no-reasoning arm keeps the lean cap", config.rootSampling.maxTokens === 4096 && config.rootSampling.reasoning === undefined);
    const calls = await drive(config, [DONE]);
    check("parity: no-reasoning arm wires no reasoning", calls[0]?.opts.reasoning === undefined && calls[0]?.opts.maxTokens === 4096);
  }

  // ── leaf shape: bench sub sampling never carries reasoning, mirrors the temperature ──
  {
    const sampling = benchSampling({ temperature: 0.3 });
    check("parity: bench leaf cap stays 2048", sampling.sub.maxTokens === 2048);
    check("parity: bench leaf mirrors the run temperature", sampling.sub.temperature === 0.3);
    check("parity: bench leaf never carries reasoning", sampling.sub.reasoning === undefined);
  }

  process.exit(failureCount() === 0 ? 0 : 1);
}

try {
  await main();
} catch (err: unknown) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
