/**
 * Root Σ WS-3/WS-4 — per-call A_t on the root: elideStalePayloads, spliceSigmaSnapshot,
 * and the RootStateTracker (dedup/caps/rectify/fences/harvest shape).
 * Run: bun run pi-plugin/rlm/test/phase-root-context.ts
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { elideStalePayloads, spliceSigmaSnapshot, type RootMessage } from "../src/core/root-context.ts";
import { RootStateTracker } from "../src/core/root-state.ts";
import { check, finish } from "./helpers.ts";

type Msg = ContextEvent["messages"][number];

function user(text: string): Msg {
  return { role: "user", content: text, timestamp: 1 } as Msg;
}
function assistant(text: string): Msg {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "t",
    model: "m", usage: {}, stopReason: "stop",
  } as unknown as Msg;
}
function toolResult(toolName: string, text: string): Msg {
  return {
    role: "toolResult", toolCallId: `t-${toolName}-${Math.random()}`, toolName,
    content: [{ type: "text", text }], isError: false,
  } as Msg;
}
function sigma(): Msg {
  return { role: "custom", customType: "rlm-sigma", content: "old snapshot", display: false, timestamp: 1 } as Msg;
}

const BIG = "y".repeat(4_000);

// ── WS-3a: elision ──────────────────────────────────────────────────────────────────
{
  const messages: RootMessage[] = [
    toolResult("read", `STALE ${BIG}`),
    sigma(),
    user("older ask"),
    assistant(`turn one response ${BIG}`),
    toolResult("bash", `FRESH ${BIG}`),
    assistant("turn two response"),
    user("latest ask"),
  ];
  const elided = elideStalePayloads(messages, { keepTurns: 2, elideChars: 1_500 });
  check("one payload elided", elided === 1, String(elided));
  const stale = (messages[0] as { content: { text: string }[] }).content[0].text;
  check("stale payload became a preview", stale.includes("chars elided — full result in session log"), stale.slice(0, 80));
  check("preview keeps head and tail", stale.startsWith("STALE") && stale.trimEnd().endsWith("y"));
  check("fresh payload untouched", JSON.stringify(messages[4]).includes(`FRESH ${BIG}`));
  check("sigma immune", (messages[1] as { content: unknown }).content === "old snapshot");
  check("final user immune", (messages[6] as { content: string }).content === "latest ask");
  check("keep window untouched", JSON.stringify(messages[3]).includes(`turn one response ${BIG}`));

  const none = elideStalePayloads(
    [user("a"), assistant("b"), user("c")],
    { keepTurns: 2, elideChars: 10 },
  );
  check("fewer turns than window ⇒ zero", none === 0);
}

// ── WS-3b: sigma splice ──────────────────────────────────────────────────────────────
{
  const tracker = RootStateTracker.fresh("splice test");
  tracker.noteFact("facts/alpha.ts — a verified fact");
  const messages: RootMessage[] = [user("first"), assistant("mid"), user("latest")];
  spliceSigmaSnapshot(messages, tracker.snapshot(), undefined);
  const sigmas = messages.filter((m) => (m as { customType?: string }).customType === "rlm-sigma");
  check("exactly one sigma", sigmas.length === 1);
  const at = messages.findIndex((m) => (m as { customType?: string }).customType === "rlm-sigma");
  check("placed before the LAST user message", at === messages.length - 2);
  const body = (sigmas[0] as { content: string }).content;
  check("block carries Σ JSON", body.startsWith("[Σ] {"));
  check("block carries the recall line", body.includes("skill_search()"));

  spliceSigmaSnapshot(messages, tracker.snapshot(), "[rectify] hint");
  const after = messages.filter((m) => (m as { customType?: string }).customType === "rlm-sigma");
  check("idempotent: still exactly one", after.length === 1);
  check("rectify hint appended", ((after[0] as { content: string }).content).includes("[rectify] hint"));
}

// ── WS-4: tracker ────────────────────────────────────────────────────────────────────
{
  const t = RootStateTracker.fresh("tracker test", 1);
  check("fresh tracker is empty + clean", t.isEmpty && !t.dirty);
  t.noteFinding("the retry table lives in util/retry.ts");
  t.noteFinding("the retry table lives in util/retry.ts"); // duplicate claim
  t.noteFact("facts/beta.ts — second fact");
  check("dedup by claim key", t.snapshot().findings.length === 1);
  check("dirty after writes", t.dirty);
  check("no longer empty", !t.isEmpty);
  t.setNextStep("run the suite, then write the report");
  check("next step set", t.snapshot().nextStep === "run the suite, then write the report");
  t.setNextStep("   "); // empty prompt must be a no-op
  check("empty next-step is a no-op", t.snapshot().nextStep === "run the suite, then write the report");

  // caps: 12 findings max — overflow evicts oldest
  for (let i = 0; i < 15; i++) t.noteFinding(`finding number ${i} with enough words to be substantive`);
  check("findings capped at 12", t.snapshot().findings.length === 12);
  check("oldest evicted first", t.snapshot().findings[0] === "finding number 3 with enough words to be substantive");
}

{
  // rectify: two consecutive failures on one key ⇒ hint; success clears it
  const t = RootStateTracker.fresh("rectify test");
  check("no hint initially", t.rectifyHint() === undefined);
  t.observeToolResult("bash", true, "exit 1");
  check("one failure ⇒ no hint yet", t.rectifyHint() === undefined);
  t.observeToolResult("bash", true, "exit 1 again");
  const hint = t.rectifyHint();
  check("two failures ⇒ hint", hint !== undefined && hint.includes("tool:bash"));
  t.observeToolResult("bash", false, "");
  check("success clears the streak", t.rectifyHint() === undefined);
  check("outcome recorded", t.snapshot().testedApproaches["tool:bash"]?.status === "succeeded");
}

{
  // WS-4.2 fences: valid patch applies; malformed rejects + surfaces observation; retry cap
  // degrades. Ladder parity with the engine (N3): ALL problems accumulate into ONE
  // observation, accepted deltas in a partially-failing batch still land, wording is the
  // shared run-state.ts source (N1).
  const ok = RootStateTracker.fresh("fence ok");
  ok.applyFences([{ ok: true, value: { state_patch: { "verifiedFacts[+]": "src/x.ts — fence fact" } } }]);
  check("valid fence applied", ok.snapshot().verifiedFacts.includes("src/x.ts — fence fact"));
  check("accepted fence clears observation", ok.takePendingObservation() === undefined);

  const strict = RootStateTracker.fresh("fence strict", 3);
  strict.applyFences([
    { ok: false, error: "Unexpected token } in JSON" },
    { ok: true, value: { state_patch: { "verifiedFacts[+]": "good fence in a mixed batch" } } },
    { ok: true, value: { state_patch: { nonexistentField: "x" } } },
  ]);
  const observation = strict.takePendingObservation() ?? "";
  check(
    "mixed batch: both problems in ONE observation (engine parity)",
    observation.includes("malformed ```state fence") && observation.includes("unknown state field"),
    observation.split("\n")[0] ?? "",
  );
  check("observation is the shared wording source", observation.includes("state patch rejected — rolled back"));
  check("good fence in the batch still landed", strict.snapshot().verifiedFacts.includes("good fence in a mixed batch"));
  check("rejections counted, tracker still active", strict.takePendingObservation() === undefined);

  strict.applyFences([{ ok: false, error: "still garbage 1" }, { ok: false, error: "still garbage 2" }]);
  check("retry-cap degrade fires on accumulated count", strict.takePendingObservation() !== undefined);
  strict.applyFences([{ ok: true, value: { state_patch: { "verifiedFacts[+]": "after degrade — ignored" } } }]);
  check("degraded tracker ignores fences", !strict.snapshot().verifiedFacts.includes("after degrade — ignored"));
}

{
  // engine mirror: findings/facts merge with dedup, approaches ride along
  const t = RootStateTracker.fresh("mirror test");
  t.noteFact("shared fact from root observations");
  t.absorbEngineState({
    task: "engine task",
    findings: ["engine finding A"],
    verifiedFacts: ["shared fact from root observations", "engine-only fact"],
    testedApproaches: { h1: { status: "succeeded", evidence: "e" } },
    artifacts: {},
    openQuestions: [],
    nextStep: "engine next",
    updatedAt: 3,
  });
  const snap = t.snapshot();
  check("engine findings merged", snap.findings.includes("engine finding A"));
  check("facts deduped across mirror", snap.verifiedFacts.filter((f) => f === "shared fact from root observations").length === 1);
  check("engine approaches merged", snap.testedApproaches.h1?.status === "succeeded");
}

finish();
