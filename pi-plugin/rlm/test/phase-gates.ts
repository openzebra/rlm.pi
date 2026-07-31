#!/usr/bin/env bun
/**
 * Unit tests for deterministic pipeline gate floors + routing.
 * Run: bun run pi-plugin/rlm/test/phase-gates.ts
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failureCount } from "./helpers.ts";
import {
  clarificationRecord,
  countBulletsUnderHeading,
  countHeadingsOutsideFences,
  lineCountOf,
  MAX_PHASES,
  phasesMissingSuccessCriteria,
  planPhaseRecords,
  validationRecord,
  verifyCitations,
} from "../src/core/gates.ts";
import { routeAfterValidate, initialPhaseState } from "../src/core/pipeline.ts";
import { captureGoal, saveArtifact, ARTIFACTS_DIR } from "../src/core/artifacts.ts";
import { resetHistoryForPhase } from "../src/core/engine.ts";
import { critiqueArtifact, formatCritique } from "../src/core/critique.ts";
import { STAGES } from "../src/core/pipeline.ts";

// ── countHeadingsOutsideFences ──

function testLineCountAndPhasesMissing(): void {
  check("lineCountOf empty is 1", lineCountOf("") === 1);
  check("lineCountOf one line is 1", lineCountOf("hello") === 1);
  check("lineCountOf two lines is 2", lineCountOf("a\nb") === 2);
  check("lineCountOf trailing newline counts", lineCountOf("a\nb\n") === 3);

  const balanced = [
    "## Phase 1: A",
    "### Success Criteria",
    "ok",
    "## Phase 2: B",
    "### Success Criteria",
    "ok",
    "## Phase 3: C",
    "### Success Criteria",
    "ok",
  ].join("\n");
  check("phasesMissingSuccessCriteria none when all have criteria", phasesMissingSuccessCriteria(balanced).length === 0);

  const skewed = [
    "## Phase 1: A",
    "### Success Criteria",
    "ok",
    "### Success Criteria",
    "extra",
    "## Phase 2: B",
    "no criteria here",
    "## Phase 3: C",
    "### Success Criteria",
    "ok",
  ].join("\n");
  const missing = phasesMissingSuccessCriteria(skewed);
  check("phasesMissingSuccessCriteria catches phase without criteria", missing.length === 1 && missing[0] === "Phase 2", String(missing));
}

function testHeadings(): void {
  const body = [
    "## Phase 1: One",
    "```",
    "## Phase 99: fenced example",
    "```",
    "## Phase 2: Two",
    "~~~",
    "## Phase 88: tilde fence",
    "~~~",
    "## Phase 3: Three",
  ].join("\n");
  check(
    "fenced ## Phase N: ignored",
    countHeadingsOutsideFences(body, /^## Phase (\d+):/) === 3,
  );
  check(
    "no headings → 0",
    countHeadingsOutsideFences("just text", /^## Phase (\d+):/) === 0,
  );
}

// ── planPhaseRecords ──

function testPlanGate(): void {
  const good = `---
status: ready
phase_count: 2
phases:
  - n: 1
    title: Alpha
  - n: 2
    title: Beta
---
## Phase 1: Alpha
### Changes Required
## Phase 2: Beta
### Changes Required
`;
  const ok = planPhaseRecords(good, "plans/x.md");
  check("matching plan ok", ok.ok && ok.value.phases.length === 2, ok.ok ? String(ok.value.phases.length) : ok.error);
  if (ok.ok) {
    check("phase 1 title", ok.value.phases[0]?.title === "Alpha");
    check("phase 2 index/total", ok.value.phases[1]?.index === 1 && ok.value.phases[1]?.total === 2);
  }

  const stale = `---
status: ready
phase_count: 1
phases:
  - n: 1
    title: Only
---
## Phase 1: Only
## Phase 2: Extra
`;
  const staleR = planPhaseRecords(stale, "plans/stale.md");
  check("stale phases array rejected", !staleR.ok && staleR.error.includes("phases"), staleR.ok ? "ok" : staleR.error);

  const wrongCount = `---
status: ready
phase_count: 99
phases:
  - n: 1
    title: A
---
## Phase 1: A
`;
  const wc = planPhaseRecords(wrongCount, "plans/wc.md");
  check("wrong phase_count rejected", !wc.ok && wc.error.includes("phase_count"), wc.ok ? "ok" : wc.error);

  const empty = `---
status: ready
phase_count: 0
phases: []
---
no phases
`;
  const emptyR = planPhaseRecords(empty, "plans/e.md");
  check("zero phases rejected", !emptyR.ok && emptyR.error.includes("no"), emptyR.ok ? "ok" : emptyR.error);

  const manyHeadings = Array.from({ length: MAX_PHASES + 1 }, (_, i) => `## Phase ${i + 1}: P${i + 1}`).join("\n");
  const manyPhases = Array.from({ length: MAX_PHASES + 1 }, (_, i) => `  - n: ${i + 1}\n    title: P${i + 1}`).join("\n");
  const over = `---
status: ready
phase_count: ${MAX_PHASES + 1}
phases:
${manyPhases}
---
${manyHeadings}
`;
  const overR = planPhaseRecords(over, "plans/over.md");
  check("MAX_PHASES exceeded rejected", !overR.ok && overR.error.includes("MAX_PHASES"), overR.ok ? "ok" : overR.error);
}

// ── verifyCitations ──

function testCitations(): void {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-cite-"));
  try {
    writeFileSync(join(tmp, "foo.ts"), "line1\nline2\nline3\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "bar.ts"), "a\nb\n");

    check(
      "resolving citation ok",
      verifyCitations("see foo.ts:2", tmp).ok,
    );
    check(
      "range citation ok",
      verifyCitations("see foo.ts:1-3", tmp).ok,
    );
    check(
      "dot-dir path ok",
      verifyCitations("src/bar.ts:1", tmp).ok,
    );
    const missing = verifyCitations("see missing.ts:1", tmp);
    check("missing file rejected", !missing.ok && missing.error.includes("unbacked"), missing.ok ? "ok" : missing.error);
    const pastEof = verifyCitations("foo.ts:99", tmp);
    check("past-EOF range rejected", !pastEof.ok && pastEof.error.includes("lines"), pastEof.ok ? "ok" : pastEof.error);
    check(
      "bare path without line ignored",
      verifyCitations("see foo.ts for details", tmp).ok,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── validationRecord ──

function testValidation(): void {
  const pass = validationRecord("---\nstatus: ready\nblockers_count: 0\nverdict: pass\n---\nok\n", "v.md");
  check("pass validation ok", pass.ok && pass.value.blockersCount === 0 && pass.value.verdict === "pass");

  const fail = validationRecord("---\nstatus: ready\nblockers_count: 2\nverdict: fail\n---\nbad\n", "v.md");
  check("fail validation ok", fail.ok && fail.value.blockersCount === 2);

  const missing = validationRecord("---\nstatus: ready\nverdict: pass\n---\n", "v.md");
  check("missing blockers_count rejected", !missing.ok && missing.error.includes("blockers_count"));

  const neg = validationRecord("---\nstatus: ready\nblockers_count: -1\nverdict: fail\n---\n", "v.md");
  check("negative blockers rejected", !neg.ok);

  const contradict = validationRecord("---\nstatus: ready\nblockers_count: 1\nverdict: pass\n---\n", "v.md");
  check("pass+blockers contradicts", !contradict.ok && contradict.error.includes("contradicts"));

  const badVerdict = validationRecord("---\nstatus: ready\nblockers_count: 0\nverdict: maybe\n---\n", "v.md");
  check("bad verdict rejected", !badVerdict.ok && badVerdict.error.includes("verdict"));
}

// ── countBulletsUnderHeading + clarificationRecord ──

function testClarification(): void {
  const body = [
    "## Problem & Intent",
    "User wants a login form for end users.",
    "",
    "## Decisions",
    "- Use session cookies",
    "- No OAuth in v1",
    "```",
    "- fenced bullet ignored",
    "```",
    "## Open Questions",
    "- MFA later?",
    "## Non-Goals",
    "- Admin portal",
  ].join("\n");
  check("bullets under Decisions = 2 (fenced ignored)", countBulletsUnderHeading(body, "Decisions") === 2);
  check("bullets under Open Questions = 1", countBulletsUnderHeading(body, "Open Questions") === 1);
  check("missing heading ⇒ 0", countBulletsUnderHeading(body, "Missing") === 0);

  const nested = [
    "## Decisions",
    "- top level decision",
    "  - nested sub-bullet ignored",
    "\t- tab-indented ignored",
    "- second top level",
  ].join("\n");
  check(
    "nested/indented bullets not counted (column-0 only)",
    countBulletsUnderHeading(nested, "Decisions") === 2,
    String(countBulletsUnderHeading(nested, "Decisions")),
  );

  const good = `---
status: ready
decisions_count: 2
open_questions_count: 1
---
${body}
`;
  const ok = clarificationRecord(good, "c.md");
  check("clarificationRecord match ok", ok.ok && ok.value.decisionsCount === 2 && ok.value.openQuestionsCount === 1);

  const stale = `---
status: ready
decisions_count: 9
open_questions_count: 1
---
${body}
`;
  const staleR = clarificationRecord(stale, "c.md");
  check("stale decisions_count rejected", !staleR.ok && staleR.error.includes("decisions_count"), staleR.ok ? "ok" : staleR.error);

  const noIntent = `---
status: ready
decisions_count: 0
open_questions_count: 0
---
## Decisions
## Open Questions
`;
  const noIntentR = clarificationRecord(noIntent, "c.md");
  check(
    "missing Problem & Intent rejected",
    !noIntentR.ok && noIntentR.error.includes("Problem & Intent"),
    noIntentR.ok ? "ok" : noIntentR.error,
  );
}

// ── routeAfterValidate ──

function testRoute(): void {
  check("blockers=0 → done", routeAfterValidate({ blockersCount: 0, verdict: "pass" }, 0, 2).kind === "done");
  const loop = routeAfterValidate({ blockersCount: 1, verdict: "fail" }, 0, 2);
  check("blockers>0 → loop-back", loop.kind === "loop-back" && loop.kind === "loop-back" && loop.next === "blueprint");
  const halt = routeAfterValidate({ blockersCount: 3, verdict: "fail" }, 2, 2);
  check("jump cap → halt", halt.kind === "halt" && halt.kind === "halt" && halt.reason.includes("backward-jump"));
  const stillLoop = routeAfterValidate({ blockersCount: 1, verdict: "fail" }, 1, 2);
  check("under cap still loops", stillLoop.kind === "loop-back");
}

// ── artifacts + history reset + critique ──

async function testArtifactsAndCritiqueAsync(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-art-"));
  try {
    const goal = captureGoal(tmp, "verbatim brief text");
    check("goal capture ok", goal.ok, goal.ok ? "ok" : goal.error);
    if (!goal.ok) return;
    check("goal path under artifacts/goal", goal.value.goalPath.includes(`${ARTIFACTS_DIR}/goal`) || goal.value.goalPath.includes(join(ARTIFACTS_DIR, "goal")));
    const { readFileSync, existsSync } = await import("node:fs");
    check("goal content verbatim", readFileSync(join(tmp, goal.value.goalPath), "utf-8") === "verbatim brief text");
    check("baseline exists", existsSync(join(tmp, goal.value.baselinePath)));

    const saved = saveArtifact(tmp, "research", "research", "---\nstatus: ready\n---\nbody\n");
    check("saveArtifact ok", saved.ok);

    const hist = resetHistoryForPhase("sys", initialPhaseState(), { goal: goal.value });
    check("history reset has system+user", hist.length === 2 && hist[0]?.role === "system" && hist[1]?.role === "user");
    check("history mentions goal path", hist[1]?.content.includes(goal.value.goalPath) === true);

    // Superseded artifact label in history
    const withSuperseded = resetHistoryForPhase("sys", {
      current: "blueprint",
      advancedAt: 0,
      artifacts: {
        blueprint: { path: ".rlm/artifacts/plans/plan-old.md", status: "superseded", supersededBy: "val.md" },
        validate: { path: "val.md", status: "active" },
      },
      backwardJumps: 1,
    });
    check(
      "history labels superseded blueprint",
      withSuperseded[1]?.content.includes("Superseded artifact from 'blueprint'") === true,
      withSuperseded[1]?.content.slice(0, 200),
    );

    // Critique preflight: draft status is a blocker
    const draft = "---\nstatus: draft\n---\n## Findings\nok\n";
    const c = critiqueArtifact(STAGES.research, draft, "x.md", tmp);
    check("critique draft has issues", !c.canAdvance && c.issues.length > 0);
    check("formatCritique has BLOCKER", formatCritique(c).includes("BLOCKER:"));

    const clean = "---\nstatus: ready\n---\n## Findings\nok\n";
    const c2 = critiqueArtifact(STAGES.research, clean, "y.md", tmp);
    check("critique ready research clean", c2.canAdvance && c2.issues.length === 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

testLineCountAndPhasesMissing();
testHeadings();
testPlanGate();
testCitations();
testValidation();
testClarification();
testRoute();
await testArtifactsAndCritiqueAsync();

console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
process.exit(failureCount() === 0 ? 0 : 1);
