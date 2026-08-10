/**
 * Batch-gate regression — `llm_batch` must not re-enter the leaf gate.
 *
 * A batch used to be wrapped in `gates.leaf.map(...)` while every `complete1` inside it took a
 * second slot on the SAME semaphore. Outer and inner acquisitions interleave, so effective
 * concurrency halved and — once the batch reached 2×limit queued prompts — every slot ended up
 * held by an outer holder waiting for an inner slot nothing could free: the ```repl``` block
 * hung forever with no error, no emit and no cost. `map_files` / `llm_query_chunked` batch 20
 * prompts at a time, so this fired on ordinary work (limit 6 ⇒ deadlock from 12 prompts up).
 *
 * Driven through the REAL createSubcallHandlers against a local OpenAI-completions endpoint —
 * no network, no tokens, no API cost.
 *
 * Run: bun run pi-plugin/rlm/test/phase-batch-gate.ts
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createSubcallHandlers, limitsFromRemaining } from "../src/bridge/handlers/index.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import type { SubcallOpts } from "../src/sandbox/sandbox.ts";
import { check, failureCount } from "./helpers.ts";

const GATE_LIMIT = 6;
/** ≥ 2×limit — below that the old topology merely halved throughput instead of deadlocking. */
const BATCH = 20;
/** The pre-fix code never resolves; anything near this bound is the deadlock. */
const DEADLOCK_MS = 15_000;
const LATENCY_MS = 60;
const ATTACHED: SubcallOpts = Object.freeze({ detached: false });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── fake provider: streams one "ok" chunk per request ──

let inFlight = 0;
let peak = 0;
let served = 0;

function sseChunk(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

const server: Server = createServer((_req, res) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  setTimeout(() => {
    inFlight -= 1;
    served += 1;
    const base = { id: "cmpl", object: "chat.completion.chunk", created: 0, model: "fake-32b" };
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
  }, LATENCY_MS);
});

await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address() as AddressInfo | null;
const port = address?.port ?? 0;

// pi-ai resolves the key from the environment for the openrouter provider; nothing leaves
// this process but requests to the loopback server above.
process.env.OPENROUTER_API_KEY ??= "test-key";

const fakeModel: Model<"openai-completions"> = Object.freeze({
  id: "fake-32b",
  name: "Fake 32B",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const emitter = new RlmEmitter();
const handlers = createSubcallHandlers({
  resolve: (_opts, depth) => ({ emitter, parentId: undefined, depth, limits: limitsFromRemaining() }),
  gates: createSubcallGates(GATE_LIMIT),
  registry: ModelRegistry.create(AuthStorage.create()),
  getLlmModel: () => fakeModel,
  getConfig: () => ({ maxPromptChars: 400_000, maxDepth: 2 }),
});

// ── the regression ──

const prompts = Array.from({ length: BATCH }, (_, i) => `question ${i}`);
const started = Date.now();
/** api_v5: batch returns SpawnResult; collect via awaitTask. */
async function runBatchAndAwait(): Promise<readonly string[] | null> {
  const spawned = await handlers.llmBatch(prompts, 0, ATTACHED);
  if (!spawned.ok || spawned.task_id === null) return null;
  const collected = await handlers.awaitTask(spawned.task_id, undefined, undefined, 0, ATTACHED);
  if (!collected.ok || collected.results === undefined) return null;
  return collected.results;
}
const outcome = await Promise.race([
  runBatchAndAwait(),
  sleep(DEADLOCK_MS).then((): null => null),
]);
const elapsed = Date.now() - started;

check(
  `batch of ${BATCH} through a limit-${GATE_LIMIT} gate completes`,
  outcome !== null,
  outcome === null ? `DEADLOCK — still waiting after ${elapsed}ms (${served}/${BATCH} served)` : `${elapsed}ms`,
);
check(
  `all ${BATCH} answers returned in order`,
  outcome !== null && outcome.length === BATCH && outcome.every((a: string) => a === "ok"),
  `${outcome?.length ?? 0} answers`,
);
check("leaf gate bound respected", peak > 0 && peak <= GATE_LIMIT, `peak=${peak}`);

// A single llm_query must still work through the same gate.
async function runSingleAndAwait(): Promise<string> {
  const spawned = await handlers.llmQuery("one", 0, ATTACHED);
  if (!spawned.ok || spawned.task_id === null) return `spawn-fail:${spawned.error ?? "?"}`;
  const collected = await handlers.awaitTask(spawned.task_id, undefined, undefined, 0, ATTACHED);
  if (!collected.ok) return collected.error ?? "await-fail";
  return collected.result ?? "";
}
const single = await Promise.race([
  runSingleAndAwait(),
  sleep(DEADLOCK_MS).then((): string => "TIMEOUT"),
]);
check("single llm_query still completes", single === "ok", single.slice(0, 60));

// ── children are bounded separately from leaves ──
// Each child engine is a Python subprocess holding its own copy of the context it inherited,
// so a shared limit with leaf HTTP calls over-admits them badly.
const CHILD_LIMIT = 2;
const childGates = createSubcallGates(GATE_LIMIT, CHILD_LIMIT);
let childPeak = 0;
let childActive = 0;
const childHandlers = createSubcallHandlers({
  resolve: (_opts, depth) => ({ emitter, parentId: undefined, depth, limits: limitsFromRemaining() }),
  gates: childGates,
  registry: ModelRegistry.create(AuthStorage.create()),
  getLlmModel: () => fakeModel,
  getConfig: () => ({ maxPromptChars: 400_000, maxDepth: 4 }),
  runChild: async () => {
    childActive += 1;
    if (childActive > childPeak) childPeak = childActive;
    await sleep(20);
    childActive -= 1;
    return { answer: "child", iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  },
  degrade: async () => "degraded",
});

const childPrompts = Array.from({ length: 8 }, (_, i) => `child ${i}`);
async function runChildBatch(): Promise<readonly string[] | null> {
  const spawned = await childHandlers.rlmBatch(childPrompts, 0, ATTACHED);
  if (!spawned.ok || spawned.task_id === null) return null;
  const collected = await childHandlers.awaitTask(spawned.task_id, undefined, undefined, 0, ATTACHED);
  if (!collected.ok || collected.results === undefined) return null;
  return collected.results;
}
const childOut = await Promise.race([
  runChildBatch(),
  sleep(DEADLOCK_MS).then((): null => null),
]);
check("child batch completes through the per-depth gate", childOut !== null);
check(
  `child gate bounds concurrency at ${CHILD_LIMIT}, below the leaf limit of ${GATE_LIMIT}`,
  childPeak > 0 && childPeak <= CHILD_LIMIT,
  `peak=${childPeak}`,
);
check("leaf gate keeps its own, larger limit", peak > CHILD_LIMIT, `leaf peak=${peak}`);

server.close();
process.exit(failureCount() > 0 ? 1 : 0);
