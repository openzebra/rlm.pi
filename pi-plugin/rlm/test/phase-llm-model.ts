/**
 * Worker-model ranking — the "cheapest available" pick, and the /rlm-config pin that must not
 * silently replace it.
 * Run: bun run pi-plugin/rlm/test/phase-llm-model.ts
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { check, failureCount } from "./helpers.ts";
import { cheapestModel, compareLlm, isFreeModel } from "../src/mode/llm-model.ts";
import { pickableModels } from "../src/ui/model-picker.ts";

interface ModelSpec {
  readonly provider: string;
  readonly id: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

function model(spec: ModelSpec): Model<Api> {
  return {
    id: spec.id,
    provider: spec.provider,
    api: "openai-completions",
    name: spec.id,
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: {
      input: spec.input ?? 0,
      output: spec.output ?? 0,
      cacheRead: spec.cacheRead ?? 0,
      cacheWrite: 0,
    },
    contextWindow: spec.contextWindow ?? 128_000,
    maxTokens: spec.maxTokens ?? 4096,
  } as unknown as Model<Api>;
}

/** Mock registry: `available` is what Pi would offer; `all` is the full catalog (if different). */
function registryOf(
  available: readonly Model<Api>[],
  all: readonly Model<Api>[] = available,
): ModelRegistry {
  return {
    getAvailable: () => [...available],
    getAll: () => [...all],
  } as unknown as ModelRegistry;
}

function ref(m: Model<Api> | undefined): string {
  return m ? `${m.provider}/${m.id}` : "(none)";
}

const free = model({ provider: "local", id: "free-32k", contextWindow: 32_000 });
const freeWide = model({ provider: "gateway", id: "free-200k", contextWindow: 200_000 });
const cheapPaid = model({ provider: "vendor", id: "cheap", input: 0.05, output: 0.2, contextWindow: 1_000_000 });
const dearPaid = model({ provider: "vendor", id: "dear", input: 3, output: 15, contextWindow: 1_000_000 });

// ── Free beats paid, whatever the catalog order ──
check(
  "a free model outranks a cheap paid one",
  compareLlm(free, cheapPaid) < 0 && compareLlm(cheapPaid, free) > 0,
);
check("isFreeModel is true only at zero on every axis", isFreeModel(free) && !isFreeModel(cheapPaid));
check(
  "cache-read-only pricing still counts as paid",
  !isFreeModel(model({ provider: "v", id: "cached", cacheRead: 0.01 })),
);

// The pre-fix bug: a stable sort returned whichever 0-cost model came first in catalog order,
// so a subscription entry with a small window could beat the real free model.
check(
  "among free models the widest context window wins",
  ref(cheapestModel(registryOf([free, freeWide, dearPaid]))) === "gateway/free-200k",
);
check(
  "catalog order does not change the pick",
  ref(cheapestModel(registryOf([freeWide, free]))) === ref(cheapestModel(registryOf([free, freeWide]))),
);

// ── Input-weighted pricing ──
// Sub-calls send a file body and get back a sentence, so a model that is cheap on input wins
// over one that is cheap on output even when the plain sum says otherwise.
const cheapIn = model({ provider: "v", id: "cheap-in", input: 1, output: 10 });
const cheapOut = model({ provider: "v", id: "cheap-out", input: 4, output: 4 });
check("input price is weighted over output", compareLlm(cheapIn, cheapOut) < 0);

// ── Determinism ──
const twinA = model({ provider: "a", id: "twin" });
const twinB = model({ provider: "b", id: "twin" });
check("identical models tie-break on provider/id", compareLlm(twinA, twinB) < 0);
check("the comparator is antisymmetric", compareLlm(twinB, twinA) > 0);
check("a model never outranks itself", compareLlm(twinA, twinA) === 0);

// ── Degenerate registries ──
check("an empty registry yields undefined", cheapestModel(registryOf([])) === undefined);
check("a single-model registry yields that model", ref(cheapestModel(registryOf([dearPaid]))) === "vendor/dear");
check("all-paid picks the cheapest", ref(cheapestModel(registryOf([dearPaid, cheapPaid]))) === "vendor/cheap");

// ── pickableModels mirrors Pi's native list (available / scoped), never getAll() ──
const catalogOnly = model({ provider: "catalog", id: "ghost", input: 0.01, output: 0.01 });
const availablePair = [cheapPaid, dearPaid] as const;
const fullCatalog = [...availablePair, catalogOnly];
const reg = registryOf(availablePair, fullCatalog);

const picked = pickableModels(reg);
check(
  "pickableModels uses getAvailable, not getAll",
  picked.length === 2 && picked.every((m) => m.provider !== "catalog"),
  picked.map(ref).join(", "),
);
check(
  "pickableModels sorts cheapest-first",
  ref(picked[0]) === "vendor/cheap" && ref(picked[1]) === "vendor/dear",
  picked.map(ref).join(", "),
);
check(
  "pickableModels with scoped models ignores the rest of available",
  pickableModels(reg, [{ model: dearPaid }]).map(ref).join(",") === "vendor/dear",
);
check(
  "pickableModels with empty scoped falls back to available",
  pickableModels(reg, []).map(ref).join(",") === "vendor/cheap,vendor/dear",
);
check("pickableModels empty available yields empty", pickableModels(registryOf([])).length === 0);

console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
process.exit(failureCount() === 0 ? 0 : 1);
