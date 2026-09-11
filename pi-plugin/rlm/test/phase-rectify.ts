/**
 * SKILL.state Workstream F — rectification at budget hard-state: rectify() is deterministic
 * over its three arms, the Σ-handoff replaces the prose walk, and a hard-budget engine run
 * chains a rectified continuation with the exact state on board. DOCTRINE: no arm ever
 * switches models or providers — that axis does not exist in RectifyAction at all.
 * Run: bun run pi-plugin/rlm/test/phase-rectify.ts
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { CompleteFn } from "../src/core/iteration.ts";
import { rectify, rectifyLabel, stateHandoff } from "../src/core/budget.ts";
import { applyPatch, freshRunState, type RunState } from "../src/core/run-state.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RlmConfig } from "../src/core/types.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { check, finish, MOCK_MODEL, MOCK_REGISTRY, repl, ZERO_USAGE } from "./helpers.ts";

function cfg(over: Partial<RlmConfig> = {}): RlmConfig {
  return { ...DEFAULT_CONFIG, enableLedger: false, compaction: false, ...over };
}

function commit(state: RunState, patchKey: Record<string, unknown>): RunState {
  const r = applyPatch(state, { state_patch: patchKey }, state.updatedAt + 1);
  if (!r.ok) throw new Error(`fixture patch failed: ${JSON.stringify(patchKey)}`);
  return r.value;
}

// ── rectify(): the three deterministic arms (model switching is not an arm) ─────────
{
  const twoPaths = commit(
    commit(freshRunState("narrow the search"), { "verifiedFacts[+]": "src/auth/login.ts — session cookie set here" }),
    { "verifiedFacts[+]": "src/auth/session.ts — expiry check" },
  );
  const narrow = rectify({ state: twoPaths, config: cfg() });
  check("arm 1: narrow-paths from Σ", narrow.kind === "narrow-paths");
  if (narrow.kind === "narrow-paths") {
    check("paths harvested and capped", narrow.paths.length === 2 && narrow.paths.includes("src/auth/login.ts"));
  }

  const onePath = commit(freshRunState("one path only"), { "verifiedFacts[+]": "src/auth/login.ts — only this one" });
  check(
    "one path alone is not enough to narrow",
    rectify({ state: onePath, config: cfg() }).kind !== "narrow-paths",
  );

  const noPaths = rectify({ state: undefined, config: cfg() });
  check("arm 2: reduce-concurrency", noPaths.kind === "reduce-concurrency" && noPaths.maxConcurrentSubcalls === 4);

  const nothing = rectify({ state: undefined, config: cfg({ maxConcurrentSubcalls: 2 }) });
  check("arm 3: none", nothing.kind === "none");
  check("labels render", rectifyLabel({ kind: "reduce-concurrency", maxConcurrentSubcalls: 4 }) === "reduce-concurrency → 4");
  check("narrow label renders", rectifyLabel({ kind: "narrow-paths", paths: ["a", "b"] }) === "narrow-paths (2)");
}

// ── stateHandoff: the handoff IS the state ───────────────────────────────────────
{
  const state = commit(
    commit(freshRunState("probe"), { "verifiedFacts[+]": "src/a.ts — fact one" }),
    { nextStep: "check the loader" },
  );
  const handoff = stateHandoff(state, "original question here", 4_000);
  check("handoff keeps the template header", handoff.includes("A prior RLM run hit its outlier token ceiling"));
  check("handoff carries compact Σ", handoff.includes('"verifiedFacts"') && handoff.includes("src/a.ts — fact one"));
  check("handoff carries the Σ next step", handoff.includes("check the loader"));
  check("no unreplaced template slots", !handoff.includes("{state}") && !handoff.includes("{next}"));
}

// ── engine-level: hard budget → rectified continuation with Σ on board ──────────
async function main(): Promise<void> {
  const RESP0 = [
    repl('print("probe")'),
    "```state",
    '{"state_patch": {"verifiedFacts[+]": "src/auth/login.ts — cookie set", "findings[+]": "src/auth/session.ts — expiry"}}',
    "```",
  ].join("\n");
  // Turn 1 must NOT finalize — finalize beats the budget cascade. A plain repl block keeps
  // the run alive so the hard cap fires and the rectified continuation chains.
  const RESP1 = repl('print("still working")');
  const DONE = repl('answer["content"] = "wrapped"\nanswer["ready"] = True');

  interface Captured {
    readonly messages: readonly { role: string; content: string }[];
  }
  const calls: Captured[] = [];
  let served = 0;
  const spendy: Usage = { ...ZERO_USAGE, input: 500, totalTokens: 500 };
  const complete: CompleteFn = async (messages) => {
    calls[calls.length] = { messages: messages.map((m) => ({ role: m.role, content: m.content })) };
    const text = [RESP0, RESP1, DONE][Math.min(served, 2)] ?? DONE;
    served += 1;
    return { text, usage: spendy };
  };

  // cap = min(262144 × 0.25, 900) = 900; soft = 720. Two 500-token turns ⇒ hard at turn 2.
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config: cfg({ enableTokenBudget: true, budgetTaskCap: 900, budgetHandoffChars: 4_000 }),
    emitter: new RlmEmitter(),
    complete,
  });
  const result = await engine({ rootPrompt: "audit the auth path", context: "ctx", depth: 0 });

  const everything = calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  check("run completes through the continuation", result.answer === "wrapped", result.answer.slice(0, 40));
  check("continuation chained", everything.includes("[continuation 1]"));
  check("handoff is the exact state (compactJSON)", everything.includes('"verifiedFacts"'));
  check("rectify directive rides the continuation prompt", everything.includes("[rectify] narrow child spawns"));
  check("rectify picked the Σ paths", everything.includes("src/auth/login.ts") && everything.includes("src/auth/session.ts"));
  check("iterations fold the chain", result.iterations >= 2, String(result.iterations));
  finish();
}

void main(); // explicit: fire-and-forget, no floating promise
