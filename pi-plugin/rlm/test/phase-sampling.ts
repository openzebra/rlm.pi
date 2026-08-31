/**
 * Sampling-to-wire integration — the r3 bench knobs (temperature / reasoning / maxTokens)
 * must reach the real engine's model calls, not just sit in rlm.json.
 *
 * Proven with temperature 0 configured:
 *   1. main-loop root turn carries rootSampling.{temperature,maxTokens,reasoning} — merge
 *      rule: rootSampling wins, smartReasoning is the reasoning default, absent = provider
 *      default;
 *   2. the FINALIZE call carries the same (regression: finalize used to ignore rootSampling
 *      entirely, so the last turn of every run ran at provider-default temperature);
 *   3. an llm_query leaf sub-call carries subSampling on the wire (local stub endpoint
 *      records the POST body — the bridge path, completion.ts);
 *   4. a depth-1 child engine inherits the same rootSampling (recursion = same engine fn);
 *   5. audit-R7 seam: buildEngine passes controller.config to createEngine verbatim;
 *   6. reasoning gating: a model whose registry entry has reasoning:false never gets a
 *      reasoning level on the wire (explicit guard, bridge/model.ts effectiveReasoning).
 *
 * Driven through the REAL createEngine + real Python sandbox + a local OpenAI-completions
 * endpoint — no network, no tokens, no API cost.
 *
 * Run: bun run pi-plugin/rlm/test/phase-sampling.ts
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { check, captureComplete, MOCK_REGISTRY, repl, failureCount } from "./helpers.ts";
import { type CompleteFn } from "../src/core/iteration.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { modelComplete, effectiveReasoning } from "../src/bridge/model.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { RlmController } from "../src/mode/rlm-mode.ts";
import type { EngineDeps } from "../src/core/engine.ts";
import type { RunRlm, RlmConfig } from "../src/core/types.ts";

// ── stub OpenAI-completions endpoint: records every POST body, answers "ok" ──

const bodies: Record<string, unknown>[] = [];

function sseChunk(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => { raw += String(c); });
  req.on("end", () => {
    try {
      bodies[bodies.length] = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      bodies[bodies.length] = {};
    }
    const base = { id: "cmpl", object: "chat.completion.chunk", created: 0, model: "fake" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })
      + sseChunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
      + "data: [DONE]\n\n",
    );
  });
  void req;
});

await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address() as AddressInfo | null;
const port = address?.port ?? 0;

// pi-ai may resolve keys from the environment for the openrouter provider; nothing leaves
// this process but requests to the loopback server above.
process.env.OPENROUTER_API_KEY ??= "test-key";

function wireModel(reasoning: boolean): Model<"openai-completions"> {
  return Object.freeze({
    id: reasoning ? "fake-reasoner" : "fake-32b",
    name: reasoning ? "Fake Reasoner" : "Fake 32B",
    api: "openai-completions" as const,
    provider: "openrouter",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning,
    input: ["text"] as ("text" | "image")[],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
}

// ── harness ──

/** The r3 reproducibility shape: temperature pinned to 0, thinking on, explicit token cap. */
const r3Sampling: Readonly<RlmConfig["rootSampling"]> = Object.freeze({
  maxTokens: 1234,
  temperature: 0,
  reasoning: "high",
});

function cfg(overrides: Partial<RlmConfig> = {}): RlmConfig {
  return Object.freeze({
    ...DEFAULT_CONFIG,
    maxIterations: 4,
    execTimeoutS: 30,
    // Keep the run minimal: no budget cascade, no compaction stub traffic.
    enableTokenBudget: false,
    compaction: false,
    ...overrides,
  });
}

async function runEngine(config: RlmConfig, complete: CompleteFn): Promise<void> {
  const engine = createEngine({
    model: wireModel(false),
    llmModel: wireModel(false),
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete,
  });
  await engine({ rootPrompt: "sampling integration test", context: "ctx", depth: 0 });
}

const DONE = repl(`answer["content"] = "42"\nanswer["ready"] = True`);

async function main(): Promise<void> {
  // ── 1. main-loop turn carries rootSampling ──
  {
    const { complete, calls } = captureComplete([DONE]);
    await runEngine(cfg({ rootSampling: r3Sampling, smartReasoning: "medium" }), complete);
    const first = calls[0];
    check("main-loop: one turn then done", calls.length === 1 && first !== undefined, `calls=${calls.length}`);
    check("main-loop: temperature reaches the model call", first?.opts.temperature === 0, String(first?.opts.temperature));
    check("main-loop: maxTokens reaches the model call", first?.opts.maxTokens === 1234, String(first?.opts.maxTokens));
    check("main-loop: rootSampling.reasoning wins over smartReasoning", first?.opts.reasoning === "high", String(first?.opts.reasoning));
  }
  // smartReasoning is the reasoning DEFAULT when rootSampling omits it.
  {
    const { complete, calls } = captureComplete([DONE]);
    await runEngine(
      cfg({ rootSampling: Object.freeze({ maxTokens: 1234, temperature: 0 }), smartReasoning: "medium" }),
      complete,
    );
    check("main-loop: smartReasoning is the reasoning default", calls[0]?.opts.reasoning === "medium", String(calls[0]?.opts.reasoning));
  }
  // Neither set → provider default (option absent, not zero).
  {
    const { complete, calls } = captureComplete([DONE]);
    await runEngine(cfg({ rootSampling: Object.freeze({ maxTokens: 1234, temperature: 0 }) }), complete);
    const opts = calls[0]?.opts;
    check("main-loop: absent reasoning stays absent (provider default)", opts?.reasoning === undefined);
  }

  // ── 2. finalize regression — the last turn must obey the user's sampling too ──
  {
    const { complete, calls } = captureComplete([repl(`print("still looking")`), "plain fallback answer"]);
    await runEngine(cfg({ maxIterations: 1, rootSampling: r3Sampling, smartReasoning: "medium" }), complete);
    const finalizeCall = calls[1];
    check("finalize: turn + finalize = 2 model calls", calls.length === 2, `calls=${calls.length}`);
    check("finalize: temperature reaches the finalize call", finalizeCall?.opts.temperature === 0, String(finalizeCall?.opts.temperature));
    check("finalize: maxTokens reaches the finalize call", finalizeCall?.opts.maxTokens === 1234, String(finalizeCall?.opts.maxTokens));
    check("finalize: rootSampling.reasoning reaches the finalize call", finalizeCall?.opts.reasoning === "high", String(finalizeCall?.opts.reasoning));
    const lastUser = finalizeCall?.messages.filter((m) => m.role === "user").at(-1);
    check("finalize: finalize prompt is on the wire", lastUser?.content.includes("Finalize NOW") === true);
  }

  // ── 3. llm_query leaf carries subSampling on the wire ──
  {
    const bodiesBefore = bodies.length;
    const { complete, calls } = captureComplete([
      repl(`print(llm_query("needle"))`),
      DONE,
    ]);
    await runEngine(
      cfg({ rootSampling: r3Sampling, subSampling: Object.freeze({ maxTokens: 777, temperature: 0.25 }) }),
      complete,
    );
    check("sub-call: engine ran turn → leaf → answer", calls.length === 2, `calls=${calls.length}`);
    const leaf = bodies.at(-1);
    check("sub-call: leaf POST hit the stub endpoint", bodies.length === bodiesBefore + 1, `bodies=${bodies.length - bodiesBefore}`);
    check("sub-call: subSampling.temperature on the wire", leaf?.["temperature"] === 0.25, String(leaf?.["temperature"]));
    // pi-ai maps maxTokens to max_tokens or max_completion_tokens per provider compat.
    const leafMax = leaf?.["max_tokens"] ?? leaf?.["max_completion_tokens"];
    check("sub-call: subSampling.maxTokens on the wire", leafMax === 777, String(leafMax));
    check("sub-call: leaf never gets reasoning (subSampling has none)", leaf?.["reasoning_effort"] === undefined);
  }

  // ── 4. depth-1 child inherits the same rootSampling (same engine fn, no depth branch) ──
  {
    const { complete, calls } = captureComplete([
      repl(`t = rlm_query("find the answer")\nprint(await_task(t))`),
      DONE, // child turn (depth 1)
      DONE, // root turn 2
    ]);
    await runEngine(cfg({ rootSampling: r3Sampling, smartReasoning: "medium" }), complete);
    // A first-turn engine request is [system, user]; only the child's first user message
    // carries its own rootPrompt (the root's first user message never contains "find the
    // answer", and later root turns run 4+ messages deep).
    const childIdx = calls.findIndex((c) =>
      c.messages.length === 2 && c.messages.at(-1)?.content.includes("find the answer"),
    );
    check("child: rlm_query spawned a child turn between root turns", childIdx === 1, `childIdx=${childIdx} calls=${calls.length}`);
    const child = calls[childIdx];
    check("child: child turn carries rootSampling.temperature", child?.opts.temperature === 0, String(child?.opts.temperature));
    check("child: child turn carries rootSampling.maxTokens", child?.opts.maxTokens === 1234, String(child?.opts.maxTokens));
    check("child: child turn carries rootSampling.reasoning", child?.opts.reasoning === "high", String(child?.opts.reasoning));
  }

  // ── 5. audit-R7 seam: buildEngine forwards controller.config verbatim ──
  {
    const config = cfg({ rootSampling: r3Sampling });
    const seen: EngineDeps[] = [];
    class ProbeController extends RlmController {
      protected override spawnEngine(deps: EngineDeps): RunRlm {
        seen[seen.length] = deps;
        return createEngine(deps);
      }
    }
    const ctrl = new ProbeController(config);
    ctrl.buildEngine({
      ctx: { modelRegistry: MOCK_REGISTRY } as unknown as ExtensionContext,
      models: { model: wireModel(false), llm: wireModel(false) },
      signal: new AbortController().signal,
      emitter: new RlmEmitter(),
    });
    check("R7 seam: deps.config IS the controller config", seen[0]?.config === config);
    check("R7 seam: rootSampling survives the controller→engine hop", seen[0]?.config.rootSampling?.temperature === 0);
  }

  // ── 6. reasoning gating — capability comes from the registry entry ──
  {
    const plain = wireModel(false);
    const reasoner = wireModel(true);
    check("gate: reasoning:false model drops the level (unit)", effectiveReasoning(plain, "high") === undefined);
    check("gate: reasoning:true model keeps the level (unit)", effectiveReasoning(reasoner, "high") === "high");
    check("gate: absent level stays absent (unit)", effectiveReasoning(reasoner, undefined) === undefined);

    const bodiesBefore = bodies.length;
    await modelComplete([{ role: "user", content: "gate probe" }], {
      model: plain,
      registry: MOCK_REGISTRY,
      maxTokens: 777,
      temperature: 0,
      reasoning: "high",
    });
    const plainBody = bodies.at(-1);
    check("gate: probe hit the stub", plainBody !== undefined);
    check("gate: wire omits reasoning for reasoning:false models", plainBody?.["reasoning_effort"] === undefined && plainBody?.["reasoning"] === undefined);
    check("gate: wire carries temperature 0 verbatim", plainBody?.["temperature"] === 0);
    const plainMax = plainBody?.["max_tokens"] ?? plainBody?.["max_completion_tokens"];
    check("gate: wire carries maxTokens", plainMax === 777, String(plainMax));

    await modelComplete([{ role: "user", content: "gate probe 2" }], {
      model: reasoner,
      registry: MOCK_REGISTRY,
      reasoning: "high",
    });
    const reasonerBody = bodies.at(-1);
    // OpenRouter-format models carry reasoning as a nested {effort} object (pi-ai compat),
    // not the flat reasoning_effort field zai/deepseek/baseten use.
    const effort = (reasonerBody?.["reasoning"] as Record<string, unknown> | undefined)?.["effort"];
    check("gate: wire carries reasoning effort for reasoning:true models", effort === "high", String(effort));
    check("gate: unset temperature is omitted, not zeroed", !("temperature" in (reasonerBody ?? {})));
    check("gate: unset maxTokens is omitted", !("max_tokens" in (reasonerBody ?? {})));
  }

  server.close();
}

try {
  await main();
  process.exit(failureCount() === 0 ? 0 : 1);
} catch (err: unknown) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
