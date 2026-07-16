#!/usr/bin/env bun
/**
 * Integration tests for the artifact-gated pipeline (mock model, no live LLM).
 * Run: bun run pi-plugin/rlm/test/phase-pipeline.ts
 * Requires: python3 on PATH
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { check, failureCount } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createEngine } from "../src/core/engine.ts";
import type { CompleteFn } from "../src/core/iteration.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { ARTIFACTS_DIR } from "../src/core/artifacts.ts";
import type { ChatMsg } from "../src/bridge/model.ts";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MOCK_MODEL = {
  id: "mock",
  provider: "test",
  api: "openai-completions" as const,
  name: "mock",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as unknown as Model<Api>;

const MOCK_REGISTRY = {
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "x", headers: {} }),
  find: () => undefined,
} as unknown as ModelRegistry;

function repl(code: string): string {
  return "```repl\n" + code + "\n```";
}

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

/** Fanout refuses when maxDepth leaves no room for a child RLM. */
async function testDepthCapRefusesFanout(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-depth-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let childSpawned = false;
  let rootTurn = 0;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("Implement ONLY Phase")) {
      childSpawned = true;
      return { text: repl(`answer["content"]="no"; answer["ready"]=True`), usage: ZERO_USAGE };
    }
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
        config: baseConfig({ maxIterations: 6, maxDepth: 1 }),
        emitter: new RlmEmitter(),
        runState: { cwd: tmp, dir: ".rlm/runs", snapshot: false },
        complete,
      });
      const res = await engine({ rootPrompt: "depth", context: "c", depth: 0 });
      check("depth cap refuses fanout with error", /maxDepth|fanout/i.test(res.answer), res.answer.slice(0, 200));
      check("no child spawned at depth cap", !childSpawned);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Loop-back requires a NEW plan: stale lastSaved plan must not re-pass the gate. */
async function testLoopBackRequiresNewPlan(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-stale-loop-"));
  writeFileSync(join(tmp, "app.ts"), "line1\n");
  let blueprintSaves = 0;
  let implementAttempts = 0;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("Implement ONLY Phase")) {
      return {
        text: repl(`stage_edit("src/p1.ts", "", "x\\n")\nanswer["content"]="done"; answer["ready"]=True`),
        usage: ZERO_USAGE,
      };
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
    if (blob.includes("You are entering the 'implement' phase") || blob.includes("implement complete")) {
      implementAttempts++;
      return { text: repl(`print(advance_phase("validate"))`), usage: ZERO_USAGE };
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
            `print(advance_phase("implement"))`,
          ),
          usage: ZERO_USAGE,
        };
      }
      return {
        text: repl(
          `r = advance_phase("implement")\n` +
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
      check("only one implement fanout (first plan)", implementAttempts === 1, String(implementAttempts));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Happy path: research → blueprint → implement fanout → validate pass. */
async function testHappyPath(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "rlm-pipe-happy-"));
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "app.ts"), "console.log(1);\n");

  const childPhases: number[] = [];
  const editsAppliedOrder: string[] = [];

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("Implement ONLY Phase")) {
      const m = /Implement ONLY Phase (\d+)/.exec(blob);
      const n = m ? Number(m[1]) : 0;
      childPhases.push(n);
      const path = `src/p${n}.ts`;
      editsAppliedOrder.push(path);
      return {
        text: repl(
          `eid = stage_edit(${JSON.stringify(path)}, "", ${JSON.stringify(`// phase ${n}\n`)})\n` +
          `print(eid)\n` +
          `answer["content"] = "phase ${n} done"\n` +
          `answer["ready"] = True`,
        ),
        usage: ZERO_USAGE,
      };
    }

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
    if (blob.includes("You are entering the 'implement' phase") || blob.includes("implement complete")) {
      return {
        text: repl(`print(advance_phase("validate", "impl done"))`),
        usage: ZERO_USAGE,
      };
    }
    if (blob.includes("You are entering the 'blueprint' phase") || blob.includes("## Blueprint phase")) {
      return {
        text: repl(
          `print(save_artifact("plan", ${JSON.stringify(planDoc(2))}))\n` +
          `print(advance_phase("implement", "plan ready"))`,
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
        rootPrompt: "add two phase files",
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
          readFileSync(join(goalDir, goalFile), "utf-8") === "add two phase files",
        );
      }

      // (c) serial children — one per plan phase
      check("exactly 2 implement children", childPhases.length === 2, String(childPhases));
      check("children in order 1 then 2", childPhases[0] === 1 && childPhases[1] === 2, String(childPhases));
      check("phase1 file applied", existsSync(join(tmp, "src/p1.ts")));
      check("phase2 file applied", existsSync(join(tmp, "src/p2.ts")));
      check(
        "phase1 content before phase2 (serial apply)",
        editsAppliedOrder[0] === "src/p1.ts" && editsAppliedOrder[1] === "src/p2.ts",
      );

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

  let advancedToImplement = false;
  let rootTurn = 0;

  const complete: CompleteFn = async (messages) => {
    const blob = historyBlob(messages);
    if (blob.includes("Implement ONLY Phase")) {
      advancedToImplement = true;
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
          `r = advance_phase("implement", "bad plan")\n` +
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
        config: baseConfig({ maxIterations: 6, maxDepth: 2 }),
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
      check("implement fanout did not run", !advancedToImplement);
      check("no p1 from fanout", !existsSync(join(tmp, "src/p1.ts")));
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
    if (blob.includes("Implement ONLY Phase")) {
      return {
        text: repl(
          `stage_edit("src/p1.ts", "", "x\\n")\n` +
          `answer["content"]="done"; answer["ready"]=True`,
        ),
        usage: ZERO_USAGE,
      };
    }
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
    if (blob.includes("You are entering the 'implement' phase") || blob.includes("implement complete")) {
      return {
        text: repl(`print(advance_phase("validate"))`),
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
          `print(advance_phase("implement", "replan"))`,
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
  await testDepthCapRefusesFanout();
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
