/**
 * Root Σ v2 R4 — the native fence ladder + idle-degrade parity (G6), driven through the REAL
 * findStatePatches parser and RootStateTracker — the exact objects the message_end hook uses
 * (src/index.ts). Covers: fence-in-assistant-text → accepted delta; fence-free idle turns →
 * degrade at RUN_STATE_IDLE_DEGRADE_TURNS; accepted-delta resets; partial-batch parity;
 * retry-cap degrade (v1 behavior kept green); degraded trackers ignore fences but keep the
 * runtime observation floor.
 *
 * Run: bun run pi-plugin/rlm/test/phase-root-fences.ts
 */

import { check, finish } from "./helpers.ts";
import { ROOT_IDLE_DEGRADE_TURNS, RootStateTracker } from "../src/core/root-state.ts";
import { findStatePatches } from "../src/text/parsing.ts";

/** An assistant reply carrying one ```state fence — exactly what message_end parses. */
function fenceText(patch: string): string {
  return `Weighing the layout.\n\`\`\`state\n${patch}\n\`\`\`\nMoving on.`;
}

const WIRE = '{"state_patch": {"verifiedFacts[+]": "src/f.ts — fence wired"}}';

{
  // ── happy path: assistant text → findStatePatches → accepted ΔΣ ──
  const t = RootStateTracker.fresh("fence flow");
  t.applyFences(findStatePatches(fenceText(WIRE)));
  check("fence in assistant text applies", t.snapshot().verifiedFacts.includes("src/f.ts — fence wired"));
  check("accepted turn clears the observation channel", t.takePendingObservation() === undefined);
  check("accepted turn resets the idle streak", t.idleTurns === 0);
  check("accepted turn keeps the tracker active", t.isActive);
}

{
  // An absent fence is free. Prose turns do not idle. A rejection starts the streak;
  // later fence-free turns continue it until the root threshold.
  const prose = RootStateTracker.fresh("prose", 99);
  for (let i = 0; i < ROOT_IDLE_DEGRADE_TURNS; i++) {
    prose.applyFences(findStatePatches(`turn ${i} replied with prose, no fence`));
  }
  check("prose turns stay active", prose.isActive && prose.idleTurns === 0);

  const t = RootStateTracker.fresh("idle ladder", 99); // retry cap deliberately out of the way
  t.observeToolResult("bash", false, ""); // the runtime floor flows before and after degrade
  t.applyFences(findStatePatches("```state\n{not json}\n```"));
  check("rejection starts the idle streak", t.idleTurns === 1 && t.isActive);
  for (let i = 1; i < ROOT_IDLE_DEGRADE_TURNS; i++) {
    t.applyFences([]);
    if (i < ROOT_IDLE_DEGRADE_TURNS - 1) check(`idle turn ${i + 1}/${ROOT_IDLE_DEGRADE_TURNS} — still active`, t.isActive);
  }
  check(`idle turn ${ROOT_IDLE_DEGRADE_TURNS} — degraded`, !t.isActive);
  check("degrade reason names the idle streak", (t.degradeReason ?? "").includes("idle degrade"));
  check("idle streak counted at the root threshold", t.idleTurns >= ROOT_IDLE_DEGRADE_TURNS);

  // R7-fix (recoverable degrade): a CLEAN fence re-activates a degraded tracker — the old
  // early-return made degrade a one-way amnesia valve (later fences dropped forever).
  t.applyFences(findStatePatches(fenceText('{"state_patch": {"verifiedFacts[+]": "after degrade — recovery fence"}}')));
  check("clean fence recovers the degraded tracker", t.isActive);
  check("recovery fence lands in Σ", t.snapshot().verifiedFacts.includes("after degrade — recovery fence"));
  check("recovery resets the idle streak", t.idleTurns === 0);
  // Recall W2 pollution fix: ONE transient failure (streak 1) no longer writes a Σ record —
  // a single binary read used to evict real approach entries and fire spurious [rectify].
  t.observeToolResult("read", true, "ENOENT: no such file or directory");
  check("single transient failure stays out of Σ", t.snapshot().testedApproaches["tool:read"] === undefined);
  t.observeToolResult("read", true, "ENOENT: no such file or directory");
  check("observation floor keeps flowing after recovery (failure repeats → Σ)", t.snapshot().testedApproaches["tool:read"]?.status === "failed");
  // A promoted tool then RECOVERING records the success with the recovery evidence.
  t.observeToolResult("read", false, "");
  check("promoted tool recovering lands succeeded", t.snapshot().testedApproaches["tool:read"]?.status === "succeeded");
  // Productive turns (toolCalls ran) never grow the idle ladder — file-editing sessions
  // were degrading before their first fence landed.
  const p = RootStateTracker.fresh("productive idle", 99);
  for (let i = 0; i < ROOT_IDLE_DEGRADE_TURNS; i++) {
    p.applyFences([], { productiveTurn: true });
  }
  check("productive turns never degrade the tracker", p.isActive && p.idleTurns === 0);
  // (the degrade reason itself was already asserted right after the degrade fired above —
  //  recovery legitimately clears it, so nothing to check here anymore)

  // a GARBAGE batch in degraded mode stays degraded (sticky against zero-progress storms)
  const g = RootStateTracker.fresh("degraded garbage", 99);
  g.applyFences(findStatePatches("```state\n{not json}\n```"));
  for (let i = 1; i < ROOT_IDLE_DEGRADE_TURNS; i++) g.applyFences([]);
  check("garbage-arm degraded", !g.isActive);
  g.applyFences(findStatePatches("```state\n{not json}\n```"));
  check("malformed batch in degraded mode keeps it degraded", !g.isActive);
  check("the garbage still surfaces its observation", (g.takePendingObservation() ?? "").includes("malformed"));
}

{
  // ── R4: one accepted delta BEFORE the threshold resets the streak — no degrade ──
  const r = RootStateTracker.fresh("idle reset", 99);
  r.applyFences(findStatePatches("```state\n{not json}\n```"));
  for (let i = 1; i < ROOT_IDLE_DEGRADE_TURNS - 1; i++) r.applyFences([]);
  check("streak warms to threshold − 1", r.idleTurns === ROOT_IDLE_DEGRADE_TURNS - 1 && r.isActive);
  r.applyFences(findStatePatches(fenceText('{"state_patch": {"verifiedFacts[+]": "reset"}}')));
  check("accepted delta resets the streak", r.idleTurns === 0 && r.isActive);
  for (let i = 0; i < ROOT_IDLE_DEGRADE_TURNS; i++) r.applyFences([]);
  check("prose after a reset does not rebuild the streak", r.idleTurns === 0 && r.isActive);
  r.applyFences(findStatePatches("```state\n{not json}\n```"));
  for (let i = 1; i < ROOT_IDLE_DEGRADE_TURNS; i++) r.applyFences([]);
  check("a new rejection rebuilds the streak to the threshold", !r.isActive);
  r.applyFences(findStatePatches(fenceText(WIRE)));
  check("degrade is recoverable — the next clean fence re-activates", r.isActive);
}

{
  // ── partial batch parity: a good fence resets idle even while a sibling is rejected ──
  const t = RootStateTracker.fresh("partial batch", 99);
  t.applyFences(findStatePatches("```state\n{not json}\n```"));
  check("warm idle streak (1)", t.idleTurns === 1);
  const mixed = `garbage first\n\`\`\`state\n{not json}\n\`\`\`\n\`\`\`state\n${WIRE}\n\`\`\``;
  t.applyFences(findStatePatches(mixed));
  check("partial batch lands the good delta", t.snapshot().verifiedFacts.includes("src/f.ts — fence wired"));
  check("accepted delta resets idle despite the sibling rejection", t.idleTurns === 0);
  check("rejection surfaces as ONE observation", (t.takePendingObservation() ?? "").includes("malformed"));
  check("tracker stays active (retry cap far away)", t.isActive);
}

{
  // ── retry-cap degrade parity (v1 behavior — kept green beside the idle ladder) ──
  const t = RootStateTracker.fresh("retry cap", 1);
  t.applyFences(findStatePatches("```state\n{bad one}\n```"));
  check("first rejection — below cap, still active", t.isActive);
  check("rejection observed", (t.takePendingObservation() ?? "").includes("state patch rejected"));
  t.applyFences(findStatePatches("```state\n{bad two}\n```"));
  check("accumulated rejections past cap — degraded", !t.isActive);
  check("retry degrade reason", (t.degradeReason ?? "").includes("retry cap"));
}

{
  // ── empty assistant text is not idle unless a rejection is outstanding ──
  const t = RootStateTracker.fresh("empty turn", 99);
  t.applyFences(findStatePatches(""));
  check("empty assistant text is not an idle turn", t.idleTurns === 0 && t.isActive);
}

finish();
