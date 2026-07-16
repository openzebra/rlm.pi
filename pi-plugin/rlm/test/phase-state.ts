#!/usr/bin/env bun
/**
 * Phase 4 state machine verification — token-free transition, persistence, & resume tests.
 * Run: bun run pi-plugin/rlm/test/phase-state.ts
 */

import { check, fail, failureCount } from "./helpers.ts";
import { advancePhase, currentPhase, phaseGatePrompt, turnsInPhase, type AdvancePhaseOutcome } from "../src/core/pipeline.ts";
import { STATE_SCHEMA_VERSION, isPhase, type PhaseRow } from "../src/state/rows.ts";
import { reconstructRlmState } from "../src/state/resume.ts";
import { appendRow, writeContextSidecar } from "../src/state/writes.ts";
import { trailPath } from "../src/state/paths.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunHeader, TurnRow } from "../src/state/rows.ts";
import { buildTurnPrompt } from "../src/prompts/user.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";


function outcomeDetail(o: AdvancePhaseOutcome): string {
  return o.ok ? o.phase : o.error;
}

// ── Phase 1: Transition validation (token-free) ──

function testTransitions(): void {
  // Forward progression — one step only (pipeline starts at clarify)
  const r0 = advancePhase(undefined, "research");
  check("undefined (clarify) → research ok", r0.ok && r0.phase === "research", outcomeDetail(r0));

  const r0b = advancePhase(undefined, "clarify");
  check("undefined → clarify fails (already at clarify)", !r0b.ok, outcomeDetail(r0b));

  const rC = advancePhase("clarify", "research");
  check("clarify → research ok", rC.ok && rC.phase === "research", outcomeDetail(rC));

  const r1 = advancePhase("research", "blueprint");
  check("research → blueprint ok", r1.ok && r1.phase === "blueprint", outcomeDetail(r1));

  const r2 = advancePhase("blueprint", "implement");
  check("blueprint → implement ok", r2.ok && r2.phase === "implement", outcomeDetail(r2));

  const r3 = advancePhase("implement", "validate");
  check("implement → validate ok", r3.ok && r3.phase === "validate", outcomeDetail(r3));

  // Terminal phase cannot advance
  const term = advancePhase("validate", "research");
  check("validate terminal rejected", !term.ok, outcomeDetail(term));

  // Backward / same phase rejected
  const back = advancePhase("blueprint", "research");
  check("blueprint → research rejected", !back.ok, outcomeDetail(back));

  const same = advancePhase("implement", "implement");
  check("implement → implement rejected", !same.ok, outcomeDetail(same));

  // Unknown phase
  const bad = advancePhase("research", "garbage");
  check("unknown phase rejected", !bad.ok && outcomeDetail(bad).includes("unknown phase"), outcomeDetail(bad));

  // Skip phases rejected (must advance one step at a time)
  const skip = advancePhase("research", "validate");
  check("research → validate (skip) rejected", !skip.ok && outcomeDetail(skip).includes("next phase"), outcomeDetail(skip));
}

// ── Phase 2: Gate prompts & helpers (token-free) ──

function testGateHelpers(): void {
  const emptyArtifacts = Object.freeze({});
  check("currentPhase(undefined) defaults to clarify", currentPhase(undefined) === "clarify");
  check(
    "currentPhase({...}) reads phase",
    currentPhase({ current: "blueprint", advancedAt: 2, artifacts: emptyArtifacts, backwardJumps: 0 }) === "blueprint",
  );

  check(
    "turnsInPhase computes correctly",
    turnsInPhase({ current: "research", advancedAt: 0, artifacts: emptyArtifacts, backwardJumps: 0 }, 2) === 2,
  );
  check("turnsInPhase(undefined, 5) === 5", turnsInPhase(undefined, 5) === 5);

  const stall = phaseGatePrompt({ current: "research", advancedAt: 0, artifacts: emptyArtifacts, backwardJumps: 0 }, 4);
  check("gate fires at turn 4 in research", stall !== undefined && stall.includes("'research'"), stall ?? "no prompt");

  const noStall = phaseGatePrompt({ current: "research", advancedAt: 0, artifacts: emptyArtifacts, backwardJumps: 0 }, 2);
  check("gate silent at turn 2", noStall === undefined, noStall ?? "undefined");

  const fresh = phaseGatePrompt({ current: "blueprint", advancedAt: 5, artifacts: emptyArtifacts, backwardJumps: 0 }, 6);
  check("gate silent early in phase", fresh === undefined, fresh ?? "undefined");

  const terminal = phaseGatePrompt({ current: "validate", advancedAt: 8, artifacts: emptyArtifacts, backwardJumps: 0 }, 12);
  check("gate fires in validate (no next phase)", terminal !== undefined && !terminal.includes("advance_phase"), terminal ?? "no prompt");
}

// ── Phase 3: Phase rows, persistence & resume ──

async function testPhasePersistence(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-phase-state-"));
  const runId = "2026-01-01_00-00-00-aaaa";
  const dir = ".rlm-test";

  try {
    // Write a header row
    const header: RunHeader = {
      kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: "2026-01-01T00:00:00Z",
      rootPrompt: "test",
      context: { type: "none", chars: 0, json: false },
      models: { model: "p/id", worker: "p/wid" },
      meta: { maxIterations: 10, maxDepth: 2, orchestrator: false, pipeline: true },
    };
    if (!await writeContextSidecar(tmp, dir, runId, "test context", false)) {
      console.log("✗ sidecar write failed — check perms?");
      fail();
      return;
    }
    check("header written", await appendRow(tmp, dir, runId, header));

    // Write a turn row
    const turn: TurnRow = {
      kind: "turn", turn: 1, ts: "2026-01-01T00:00:01Z",
      response: "ok", error: false,
      usage: { costUsd: 0, inputTokens: 1, outputTokens: 2 },
      cumulativeDurationMs: 100,
      snapshotOk: false,
    };
    check("turn row written", await appendRow(tmp, dir, runId, turn));

    // Write a phase row
    const phaseRow: PhaseRow = {
      kind: "phase", turn: 2, ts: "2026-01-01T00:00:02Z",
      phase: "blueprint", summary: "research complete",
    };
    check("phase row written", await appendRow(tmp, dir, runId, phaseRow));

    // Write another turn and another phase row
    const turn2: TurnRow = {
      kind: "turn", turn: 2, ts: "2026-01-01T00:00:03Z",
      response: "working", error: false,
      usage: { costUsd: 100, inputTokens: 50, outputTokens: 30 },
      cumulativeDurationMs: 200,
      snapshotOk: false,
    };
    check("turn2 row written", await appendRow(tmp, dir, runId, turn2));

    const phaseRow2: PhaseRow = {
      kind: "phase", turn: 3, ts: "2026-01-01T00:00:04Z",
      phase: "implement", summary: "blueprint complete",
    };
    check("phase2 row written", await appendRow(tmp, dir, runId, phaseRow2));

    // Verify trail file has rows
    const trail = readFileSync(trailPath(tmp, dir, runId), "utf8");
    const lines = trail.trim().split("\n");
    check("trail has 5 rows", lines.length === 5, String(lines.length));

    // Parse and verify phase rows
    const rows = lines.map((line) => JSON.parse(line));
    const phaseRows = rows.filter(isPhase);
    check("two phase rows found", phaseRows.length === 2, String(phaseRows.length));
    check("first phase = blueprint", phaseRows[0]?.phase === "blueprint");
    check("second phase = implement", phaseRows[1]?.phase === "implement");

    // Reconstruct and verify phase state
    const system = buildRlmSystemPrompt({ contextType: "none", contextChars: 0 });
    const recon = await reconstructRlmState(tmp, dir, runId, system);
    check("reconstruct ok", recon.ok, recon.ok ? "ok" : `${recon.reason}: ${recon.detail}`);
    if (recon.ok) {
      check("recon has phase", recon.phase !== undefined);
      check("recon phase = implement", recon.phase?.current === "implement");
      check("recon phase advancedAt = 2", recon.phase?.advancedAt === 2);
      check("recon phase summary", recon.phase?.summary === "blueprint complete");
      check("recon completedTurns = 2", recon.completedTurns === 2);
    }

    // Pre-v2 trail without phase rows
    const v2RunId = "2025-12-31_23-59-59-bbbb";
    const v2Header: RunHeader = {
      kind: "header", v: 2, runId: v2RunId, ts: "2025-12-31T23:59:59Z",
      rootPrompt: "v2", context: { type: "none", chars: 0, json: false },
      models: { model: "p/id", worker: "p/wid" },
      meta: { maxIterations: 5, maxDepth: 1, orchestrator: false },
    };
    await writeContextSidecar(tmp, dir, v2RunId, "v2 context", false);
    await appendRow(tmp, dir, v2RunId, v2Header);
    await appendRow(tmp, dir, v2RunId, {
      kind: "turn", turn: 1, ts: "2025-12-31T23:59:59Z",
      response: "v2", error: false,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      cumulativeDurationMs: 0, snapshotOk: false,
    } as TurnRow);

    // v2 trail should fail resume (version mismatch)
    const v2Recon = await reconstructRlmState(tmp, dir, v2RunId, system);
    check("v2 trail fails version-mismatch", !v2Recon.ok && v2Recon.reason === "version-mismatch", v2Recon.ok ? "unexpected ok" : `${v2Recon.reason}: ${v2Recon.detail}`);

    // Current-schema header without phase rows
    const v4RunId = "2026-06-01_12-00-00-cccc";
    const v4Header: RunHeader = {
      kind: "header", v: STATE_SCHEMA_VERSION, runId: v4RunId, ts: "2026-06-01T12:00:00Z",
      rootPrompt: "v3", context: { type: "none", chars: 0, json: false },
      models: { model: "p/id", worker: "p/wid" },
      meta: { maxIterations: 5, maxDepth: 1, orchestrator: false },
    };
    await writeContextSidecar(tmp, dir, v4RunId, "v4 context", false);
    await appendRow(tmp, dir, v4RunId, v4Header);
    const v4Turn: TurnRow = {
      kind: "turn", turn: 1, ts: "2026-06-01T12:00:01Z",
      response: "v4 turn", error: false,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      cumulativeDurationMs: 0, snapshotOk: false,
    };
    await appendRow(tmp, dir, v4RunId, v4Turn);
    const v4Recon = await reconstructRlmState(tmp, dir, v4RunId, system);
    check("v4 trail without phase rows reconstructs ok", v4Recon.ok, v4Recon.ok ? "ok" : `${v4Recon.reason}: ${v4Recon.detail}`);
    if (v4Recon.ok) {
      check("v4 trail phase is undefined", v4Recon.phase === undefined);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Phase 4: Turn prompt with gate message ──

function testGatePromptIntegration(): void {
  const p0 = buildTurnPrompt(2, 10);
  check("turn prompt without gate is short", p0 === "Turn 3/10:", p0);

  const p1 = buildTurnPrompt(2, 10, "Gate message here");
  check("turn prompt includes gate", p1.includes("Gate message here") && p1.includes("Turn 3/10:"), p1);

  const p2 = buildTurnPrompt(0, 10, "First turn gate");
  check("first turn prompt includes gate and intro", p2.includes("First turn gate") && p2.includes("not interacted"), p2);
}

// ── Phase 5: isPhase guard ──

function testIntents(): void {
  check("isPhase valid", isPhase({ kind: "phase", turn: 1, ts: "ts", phase: "blueprint" }));
  check("isPhase rejects missing phase", !isPhase({ kind: "phase", turn: 1, ts: "ts" }));
  check("isPhase rejects wrong kind", !isPhase({ kind: "turn", turn: 1, phase: "blueprint" }));
  check("isPhase rejects null", !isPhase(null));
  check("isPhase rejects string", !isPhase("phase"));
  check("STATE_SCHEMA_VERSION = 5", STATE_SCHEMA_VERSION === 5, String(STATE_SCHEMA_VERSION));
}

// ── Run ──

testTransitions();
testGateHelpers();
await testPhasePersistence();
testGatePromptIntegration();
testIntents();

console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
process.exit(failureCount() === 0 ? 0 : 1);
