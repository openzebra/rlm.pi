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
  // ── R4: the idle ladder — fence-free turns degrade at the ROOT threshold (6; the engine's
  // 4 amputated before native cold-start fences land — see ROOT_IDLE_DEGRADE_TURNS) ──
  const t = RootStateTracker.fresh("idle ladder", 99); // retry cap deliberately out of the way
  t.observeToolResult("bash", false, ""); // the runtime floor flows before and after degrade
  for (let i = 1; i < ROOT_IDLE_DEGRADE_TURNS; i++) {
    t.applyFences(findStatePatches(`turn ${i} replied with prose, no fence`));
    check(`idle turn ${i}/${ROOT_IDLE_DEGRADE_TURNS} — still active`, t.isActive);
  }
  t.applyFences(findStatePatches("")); // an empty assistant text counts too (message_end feeds it verbatim)
  check(`idle turn ${ROOT_IDLE_DEGRADE_TURNS} — degraded`, !t.isActive);
  check("degrade reason names the idle streak", (t.degradeReason ?? "").includes("idle degrade"));
  check("idle streak counted at the root threshold", t.idleTurns >= ROOT_IDLE_DEGRADE_TURNS);

  // degraded: fences are ignored, splices would stop (isActive false), the floor keeps writing
  const factsBefore = t.snapshot().verifiedFacts.length;
  t.applyFences(findStatePatches(fenceText('{"state_patch": {"verifiedFacts[+]": "after degrade — must be ignored"}}')));
  check("degraded tracker ignores fences", t.snapshot().verifiedFacts.length === factsBefore);
  t.observeToolResult("read", true, "ENOENT: no such file or directory");
  check("degraded tracker keeps the observation floor", t.snapshot().testedApproaches["tool:read"]?.status === "failed");
  check("degraded tracker never throws on later turns", t.degradeReason !== undefined);
}

{
  // ── R4: one accepted delta BEFORE the threshold resets the streak — no degrade ──
  const r = RootStateTracker.fresh("idle reset", 99);
  for (let i = 0; i < ROOT_IDLE_DEGRADE_TURNS - 1; i++) r.applyFences([]);
  check("streak warms to threshold − 1", r.idleTurns === ROOT_IDLE_DEGRADE_TURNS - 1 && r.isActive);
  r.applyFences(findStatePatches(fenceText('{"state_patch": {"verifiedFacts[+]": "reset"}}')));
  check("accepted delta resets the streak", r.idleTurns === 0 && r.isActive);
  for (let i = 0; i < ROOT_IDLE_DEGRADE_TURNS - 1; i++) r.applyFences([]);
  check("streak rebuilds without carrying the old count", r.idleTurns === ROOT_IDLE_DEGRADE_TURNS - 1 && r.isActive);
  r.applyFences([]); // rebuilt streak (3) + this one = the 4th consecutive idle turn
  check("the rebuilt streak degrades exactly at the threshold", !r.isActive);
}

{
  // ── partial batch parity: a good fence resets idle even while a sibling is rejected ──
  const t = RootStateTracker.fresh("partial batch", 99);
  t.applyFences([]);
  t.applyFences([]);
  t.applyFences([]);
  check("warm idle streak (3)", t.idleTurns === 3);
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
  // ── empty assistant text is one idle turn (index.ts feeds it verbatim) ──
  const t = RootStateTracker.fresh("empty turn", 99);
  t.applyFences(findStatePatches(""));
  check("empty assistant text is one idle turn", t.idleTurns === 1 && t.isActive);
}

finish();
