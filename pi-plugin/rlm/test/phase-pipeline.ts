#!/usr/bin/env bun
/**
 * Integration tests for the artifact-gated pipeline (mock model, no live LLM).
 * Run: bun run pi-plugin/rlm/test/phase-pipeline.ts
 * Requires: python3 on PATH
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY, repl, ZERO_USAGE } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createEngine } from "../src/core/engine.ts";
import type { CompleteFn } from "../src/core/iteration.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { ARTIFACTS_DIR } from "../src/core/artifacts.ts";
import type { ChatMsg } from "../src/bridge/model.ts";

function historyBlob(messages: readonly ChatMsg[]): string {
  return messages.map((m) => m.content).join("\n");
}

const RESEARCH_DOC = `---
status: ready
---
# Research
The target is \`app.ts:1\`.
`;

function planDoc(phases: number, staleArray = false): string {
  const headings = Array.from({ length: phases }, (_, i) =>
    `## Phase ${i + 1}: Phase${i + 1}\n### Changes Required\n- src/p${i + 1}.ts: create file\n### Success Criteria\n#### Automated Verification:\necho ok\n`,
  ).join("\n");
  const arrayLen = staleArray ? Math.max(0, phases - 1) : phases;
  const arr = Array.from({ length: arrayLen }, (_, i) => `  - n: ${i + 1}\n    title: Phase${i + 1}`).join("\n");
  return `---
status: ready
phase_count: ${arrayLen}
phases:
${arr}
---
${headings}
`;
}

const VALIDATION_PASS = `---
status: ready
blockers_count: 0
verdict: pass
---
# Validation
All criteria met.
`;

const VALIDATION_FAIL = `---
status: ready
blockers_count: 1
verdict: fail
---
# Validation
Blocker: app.ts:1 still wrong.
`;

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function baseConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  return {
    ...DEFAULT_CONFIG,
    pipeline: true,
    // Existing scripted walks start at research; clarify is covered by dedicated tests.
    askUserQuestion: false,
    maxDepth: 3,
    compaction: false,
    orchestrator: false,
    maxBackwardJumps: 2,
    ...overrides,
  };
}

const CLARIFY_DOC = `---
status: ready
decisions_count: 1
open_questions_count: 0
---
## Problem & Intent
User wants a greeting helper for end users.

## Decisions
- Add greet(name) to app.ts

## Open Questions

## Non-Goals
- Full i18n
`;

/** Clarify: advance without ask_user_question is rejected; one ask + save advances. */
async function testClarifyRequiresAskRound(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-clarify-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let askCalls = 0;
  let rootTurn = 0;
  let enteredResearch = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'research' phase") || blob.includes("## Research phase")) {
      enteredResearch = true;
      return {
        text: repl(`answer["content"]="reached research"; answer["ready"]=True`),
        usage: ZERO_USAGE,
      };
    }
    rootTurn++;
    if (rootTurn === 1) {
      // Valid artifact but zero asks → must fail
      return {
        text: repl(
          `print(save_artifact("clarification", ${JSON.stringify(CLARIFY_DOC)}))\n` +
          `r = advance_phase("research")\n` +
          `print(r)\n` +
          `answer["content"] = r\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(`answer["content"]="fallback"; answer["ready"]=True`),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 4, askUserQuestion: true }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        onAskUserQuestion: async (qs) => {
          askCalls++;
          return qs.map((q) => ({
            question: q.question,
            selected: [q.options[0]?.label ?? "ok"],
          }));
        },
        complete,
      });
      const res = await engine({ rootPrompt: "greet me", context: "c", depth: 0 });
      check(
        "clarify without ask rejected",
        /ask_user_question|interview/i.test(res.answer),
        res.answer.slice(0, 200),
      );
      check("did not enter research without ask", !enteredResearch);
      check("no ask rounds counted (model never called)", askCalls === 0, String(askCalls));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Clarify success path: one ask + valid artifact → research. */
async function testClarifyAdvancesAfterAsk(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-clarify-ok-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let askCalls = 0;
  let enteredResearch = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'research' phase") || blob.includes("## Research phase")) {
      enteredResearch = true;
      return {
        text: repl(`answer["content"]="reached research"; answer["ready"]=True`),
        usage: ZERO_USAGE,
      };
    }
    // clarify phase
    return {
      text: repl(
        `print(ask_user_question([{"question":"Who is this for?","header":"Intent","options":[{"label":"end user"},{"label":"operator"}]}]))\n` +
        `print(save_artifact("clarification", ${JSON.stringify(CLARIFY_DOC)}))\n` +
        `print(advance_phase("research", "interview done"))`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 6, askUserQuestion: true }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        onAskUserQuestion: async (qs) => {
          askCalls++;
          return qs.map((q) => ({
            question: q.question,
            selected: [q.options[0]?.label ?? "ok"],
          }));
        },
        complete,
      });
      const res = await engine({ rootPrompt: "greet me", context: "c", depth: 0 });
      check("at least one ask serviced", askCalls >= 1, String(askCalls));
      check("entered research after clarify", enteredResearch);
      check("final answer from research", /reached research/i.test(res.answer), res.answer.slice(0, 120));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Config askUserQuestion on but host never wired onAskUserQuestion ⇒ start at research
 * (avoids deadlock: every ask would throw and askRounds stays 0 forever).
 */
async function testAskOnButNoCallbackStartsAtResearch(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-nocb-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let sawClarifyEntry = false;
  let sawResearchEntry = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'clarify' phase") || blob.includes("## Clarify phase")) {
      sawClarifyEntry = true;
    }
    if (blob.includes("You are entering the 'research' phase") || blob.includes("## Research phase")) {
      sawResearchEntry = true;
    }
    return {
      text: repl(`answer["content"]="started"; answer["ready"]=True`),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 3, askUserQuestion: true }),
        // intentionally no onAskUserQuestion
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      await engine({ rootPrompt: "x", context: "c", depth: 0 });
      check("config on + no callback: no clarify entry", !sawClarifyEntry);
      check("config on + no callback: starts at research", sawResearchEntry);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** askUserQuestion off ⇒ start at research (never mentions clarify phase entry). */
async function testAskOffStartsAtResearch(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-noask-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let sawClarifyEntry = false;
  let sawResearchEntry = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'clarify' phase") || blob.includes("## Clarify phase")) {
      sawClarifyEntry = true;
    }
    if (blob.includes("You are entering the 'research' phase") || blob.includes("## Research phase")) {
      sawResearchEntry = true;
    }
    return {
      text: repl(`answer["content"]="started"; answer["ready"]=True`),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 3, askUserQuestion: false }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      await engine({ rootPrompt: "x", context: "c", depth: 0 });
      check("ask off: no clarify phase entry", !sawClarifyEntry);
      check("ask off: starts at research", sawResearchEntry);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Retired implement phase is rejected as unknown. */
async function testImplementUnknownPhase(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-impl-gone-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let rootTurn = 0;

  const complete: CompleteFn = async () => {
    rootTurn++;
    if (rootTurn === 1) {
      return {
        text: repl(
          `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
          `print(advance_phase("blueprint"))`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `print(save_artifact("plan", ${JSON.stringify(planDoc(1))}))\n` +
        `r = advance_phase("implement")\n` +
        `print(r)\n` +
        `answer["content"] = r\n` +
        `answer["ready"] = True`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 6 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      const res = await engine({ rootPrompt: "impl gone", context: "c", depth: 0 });
      check(
        "advance_phase implement returns unknown phase",
        /unknown phase 'implement'/i.test(res.answer),
        res.answer.slice(0, 200),
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** save_artifact with draft plan returns BLOCKER immediately (preflight critique). */
async function testSaveArtifactCritique(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-critique-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let rootTurn = 0;
  const draftPlan = `---
status: draft
phase_count: 1
phases:
  - n: 1
    title: Phase1
---
## Phase 1: Phase1
### Changes Required
- app.ts:1 change
`;

  const complete: CompleteFn = async () => {
    rootTurn++;
    if (rootTurn === 1) {
      return {
        text: repl(
          `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
          `print(advance_phase("blueprint"))`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `r = save_artifact("plan", ${JSON.stringify(draftPlan)})\n` +
        `print(r)\n` +
        `answer["content"] = r\n` +
        `answer["ready"] = True`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 6 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      const res = await engine({ rootPrompt: "critique", context: "c", depth: 0 });
      check("save_artifact draft returns BLOCKER", /BLOCKER:/i.test(res.answer), res.answer.slice(0, 300));
      check("save_artifact not bare ok — saved only", !/^ok — saved [^\n]+$/.test(res.answer.trim()));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Loop-back requires a NEW plan: stale lastSaved plan must not re-pass the gate.
 *  Superseded blueprint ref is kept in context (C2). */
async function testLoopBackRequiresNewPlan(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-stale-loop-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let blueprintSaves = 0;
  let sawSuperseded = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("Superseded artifact from 'blueprint'")) {
      sawSuperseded = true;
    }
    if (blob.includes("You are entering the 'validate' phase") || blob.includes("## Validate phase")) {
      return {
        text: repl(
          `print(save_artifact("validation", ${JSON.stringify(VALIDATION_FAIL)}))\n` +
          `answer["content"] = "fail"\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    if (
      blob.includes("You are entering the 'blueprint' phase")
      || blob.includes("## Blueprint phase")
      || blob.includes("Previous validation found")
    ) {
      blueprintSaves++;
      // First blueprint: save plan + advance. Second entry (loop-back): try advance WITHOUT re-save.
      if (blueprintSaves === 1) {
        return {
          text: repl(
            `print(save_artifact("plan", ${JSON.stringify(planDoc(1))}))\n` +
            `print(advance_phase("validate"))`,
          ),
          usage: ZERO_USAGE,
        };
      }
      return {
        text: repl(
          `r = advance_phase("validate")\n` +
          `print(r)\n` +
          `answer["content"] = r\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
        `print(advance_phase("blueprint"))`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 16, maxBackwardJumps: 2 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      const res = await engine({ rootPrompt: "stale loop", context: "c", depth: 0 });
      check("loop-back re-entered blueprint", blueprintSaves >= 2, String(blueprintSaves));
      check(
        "stale plan without re-save is rejected",
        /no saved artifact|save_artifact/i.test(res.answer),
        res.answer.slice(0, 200),
      );
      check("superseded blueprint ref kept in context", sawSuperseded);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function gitState(cwd: string): string {
  return execFileSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
}

/** Happy path: research → blueprint → validate pass. Read-only — no tree writes. */
async function testHappyPath(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-happy-"));
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "app.ts"), "console.log(1);\n");
  // Artifact dir is host-side (not Python open); ignore so git status proves no source writes.
  writeFileSync(join(tmp, ".gitignore"), ".rlm/\n");
  execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: tmp, stdio: "ignore",
  });
  const appBefore = readFileSync(join(tmp, "app.ts"), "utf-8");
  const beforeGit = gitState(tmp);

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);

    if (blob.includes("You are entering the 'validate' phase") || blob.includes("## Validate phase")) {
      return {
        text: repl(
          `print(save_artifact("validation", ${JSON.stringify(VALIDATION_PASS)}))\n` +
          `answer["content"] = "all good"\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    if (blob.includes("You are entering the 'blueprint' phase") || blob.includes("## Blueprint phase")) {
      return {
        text: repl(
          `print(save_artifact("plan", ${JSON.stringify(planDoc(2))}))\n` +
          `print(advance_phase("validate", "plan ready"))`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
        `print(advance_phase("blueprint", "research done"))`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 12 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });

      const res = await engine({
        rootPrompt: "plan two phase files",
        context: "small fixture",
        depth: 0,
      });

      // (a) goal + baseline
      const goalDir = join(tmp, ARTIFACTS_DIR, "goal");
      check("goal dir exists", existsSync(goalDir));
      const goalFiles = readdirSync(goalDir);
      check("goal file written", goalFiles.some((f) => f.startsWith("goal-")));
      check("baseline file written", goalFiles.some((f) => f.startsWith("baseline-")));
      const goalFile = goalFiles.find((f) => f.startsWith("goal-"));
      if (goalFile !== undefined) {
        check(
          "goal content verbatim",
          readFileSync(join(goalDir, goalFile), "utf-8") === "plan two phase files",
        );
      }

      // Read-only: working tree source files unchanged
      check("app.ts unchanged (read-only pipeline)", readFileSync(join(tmp, "app.ts"), "utf-8") === appBefore);
      check("no phase1 file created", !existsSync(join(tmp, "src/p1.ts")));
      check("no phase2 file created", !existsSync(join(tmp, "src/p2.ts")));
      const afterGit = gitState(tmp);
      check(
        "pipeline is read-only — working tree unchanged",
        afterGit === beforeGit,
        `before=${JSON.stringify(beforeGit)} after=${JSON.stringify(afterGit)}`,
      );

      // Python open write must be refused under pipeline read-only
      // (probed via a separate assertion in smoke; here we verify source integrity)

      check("final answer not error", !res.answer.startsWith("Error:"), res.answer.slice(0, 200));
      check("final mentions success", /all good|pass|complete/i.test(res.answer), res.answer.slice(0, 200));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Stale phases: array reject — phase does not advance. */
async function testStalePlanGate(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-stale-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");

  let enteredValidate = false;
  let rootTurn = 0;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'validate' phase") || blob.includes("## Validate phase")) {
      enteredValidate = true;
      return {
        text: repl(`answer["content"]="should not run"; answer["ready"]=True`),
        usage: ZERO_USAGE,
      };
    }
    rootTurn++;
    if (rootTurn === 1) {
      return {
        text: repl(
          `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
          `print(advance_phase("blueprint", "ok"))`,
        ),
        usage: ZERO_USAGE,
      };
    }
    if (rootTurn === 2) {
      return {
        text: repl(
          `print(save_artifact("plan", ${JSON.stringify(planDoc(2, true))}))\n` +
          `r = advance_phase("validate", "bad plan")\n` +
          `print(r)\n` +
          `answer["content"] = r\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(`answer["content"]="fallback"; answer["ready"]=True`),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 6 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });

      const res = await engine({
        rootPrompt: "stale plan test",
        context: "ctx",
        depth: 0,
      });

      const sawGateError = res.answer.includes("phases") || res.answer.includes("Error:");
      check("stale plan gate error surfaced", sawGateError, res.answer.slice(0, 200));
      check("validate not entered on bad plan", !enteredValidate);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Validate fail → loop-back once, then halt at maxBackwardJumps=1. */
async function testLoopBackAndHalt(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-loop-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");

  let blueprintEntries = 0;
  let validateFinalizes = 0;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'validate' phase") || blob.includes("## Validate phase")) {
      validateFinalizes++;
      return {
        text: repl(
          `print(save_artifact("validation", ${JSON.stringify(VALIDATION_FAIL)}))\n` +
          `answer["content"] = "validation report: 1 blocker"\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    if (
      blob.includes("You are entering the 'blueprint' phase")
      || blob.includes("## Blueprint phase")
      || blob.includes("Previous validation found")
    ) {
      blueprintEntries++;
      return {
        text: repl(
          `print(save_artifact("plan", ${JSON.stringify(planDoc(1))}))\n` +
          `print(advance_phase("validate", "replan"))`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
        `print(advance_phase("blueprint"))`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 20, maxBackwardJumps: 1 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });

      const res = await engine({
        rootPrompt: "loop test",
        context: "ctx",
        depth: 0,
      });

      check("blueprint entered at least twice (initial + loop)", blueprintEntries >= 2, String(blueprintEntries));
      check("validate finalized at least twice", validateFinalizes >= 2, String(validateFinalizes));
      check(
        "halt mentions backward-jump or blockers",
        /backward-jump|blocker/i.test(res.answer),
        res.answer.slice(0, 240),
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** (d) History length drops at phase boundary — unit via resetHistoryForPhase shape. */
async function testHistoryResetOnBoundary(): Promise<void> {
  // Scripted: after research advance, next root turn history should be short (system+user only
  // from reset, plus turn prompt). We observe via complete() message count.
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-hist-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let minHistoryAfterAdvance = Infinity;
  let sawPostAdvance = false;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("You are entering the 'blueprint' phase")) {
      sawPostAdvance = true;
      minHistoryAfterAdvance = Math.min(minHistoryAfterAdvance, messages.length);
      return {
        text: repl(
          `print(save_artifact("plan", ${JSON.stringify(planDoc(1))}))\n` +
          `answer["content"] = "hist ok"\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }
    return {
      text: repl(
        `print(save_artifact("research", ${JSON.stringify(RESEARCH_DOC)}))\n` +
        `print(advance_phase("blueprint", "done"))`,
      ),
      usage: ZERO_USAGE,
    };
  };

  try {
    await withCwd(tmp, async () => {
      const engine = createEngine({
        model: MOCK_MODEL,
        workerModel: MOCK_MODEL,
        registry: MOCK_REGISTRY,
        config: baseConfig({ maxIterations: 4, maxDepth: 1 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      await engine({ rootPrompt: "hist", context: "c", depth: 0 });
      check("saw post-advance phase history", sawPostAdvance);
      // Fresh session: system + phase user + turn user ≈ 3, not growing transcript
      check(
        "history short after phase boundary",
        minHistoryAfterAdvance <= 4,
        String(minHistoryAfterAdvance),
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  check("ARTIFACTS_DIR constant", ARTIFACTS_DIR === ".rlm/artifacts");
  await testHappyPath();
  await testStalePlanGate();
  await testLoopBackAndHalt();
  await testHistoryResetOnBoundary();
  await testImplementUnknownPhase();
  await testSaveArtifactCritique();
  await testLoopBackRequiresNewPlan();
  await testClarifyRequiresAskRound();
  await testClarifyAdvancesAfterAsk();
  await testAskOffStartsAtResearch();
  await testAskOnButNoCallbackStartsAtResearch();
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
