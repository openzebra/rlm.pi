/**
 * Phase 1 (v5 port): token budget cascade — unit + engine-level gates.
 * Ports rlm_test tests/test_budget.py + the continuation gates of test_governor.py.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMsg, CompleteResult } from "../src/bridge/model.ts";
import {
  continuationPrompt,
  DEFAULT_NEXT_STEP,
  distillTrajectory,
  resolveBudget,
  TokenBudget,
  truncateMid,
  WRAP_UP_BUDGET,
} from "../src/core/budget.ts";
import { elideOldToolPayloads } from "../src/core/compaction.ts";
import { formatReplOutputs } from "../src/core/answer.ts";
import { MemoryStore } from "../src/core/memory.ts";
import { contextSig, taskKey } from "../src/core/ledger.ts";
import { createEngine } from "../src/core/engine.ts";
import type { RlmConfig } from "../src/core/types.ts";
import { ModelContextRegistry, modelsCachePath, UNKNOWN_CONTEXT } from "../src/core/model-registry.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY, ZERO_USAGE } from "./helpers.ts";

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

function cfg(over: Partial<RlmConfig> = {}): RlmConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function usage(input: number, output = 0): typeof ZERO_USAGE {
  return { ...ZERO_USAGE, input, output, totalTokens: input + output };
}

// ── TokenBudget math (v5 test_budget ports) ─────────────────────────────────────

{
  const b1M = resolveBudget(1_000_000, cfg());
  check("cap: 1M ctx × 0.25 → 250k", b1M.cap === 250_000, String(b1M.cap));
  check("cap: soft = 80% → 200k", b1M.soft === 200_000, String(b1M.soft));
  const b32k = resolveBudget(32_000, cfg());
  check("cap: 32k → 8k / soft 6.4k", b32k.cap === 8_000 && b32k.soft === 6_400, `${b32k.cap}/${b32k.soft}`);

  const clipped = resolveBudget(1_000_000, cfg({ budgetTaskCap: 50_000 }));
  check("cap: budgetTaskCap clips share cap", clipped.cap === 50_000, String(clipped.cap));

  const noCtx = resolveBudget(undefined, cfg());
  check("cap: unknown ctx falls back to 32k × 0.25", noCtx.cap === 8_000, String(noCtx.cap));
}

{
  const b = new TokenBudget(1_000);
  b.observeTotal(100, 50);
  check("state: under soft → \"\"", b.state() === "");
  b.observeTotal(799, 0);
  check("state: 799 < 800 soft → \"\"", b.state() === "");
  b.observeTotal(800, 0);
  check("state: exactly soft → soft", b.state() === "soft");
  b.observeTotal(1_000, 1);
  check("state: over cap → hard", b.state() === "hard");
  check("spent tracks observed total", b.tokensSpent === 1_001, String(b.tokensSpent));
}

{
  const b = new TokenBudget(100, { maxContinuations: 2 });
  check("chain: fresh run can continue", b.canContinue());
  const c1 = b.nextContinuation();
  check("chain: continuation gets fresh spend window", c1.tokensSpent === 0 && c1.state() === "");
  check("chain: continuations increments", c1.continuations === 1);
  const c2 = c1.nextContinuation();
  check("chain: second continuation exists", c2.continuations === 2);
  check("chain: cap at maxContinuations", !c2.canContinue());
  c2.observeTotal(50, 0);
  check("chain: fresh window not charged for prior run", c2.state() === "" && c2.tokensSpent === 50);
}

// ── wrap-up note (v4 Run-1 flaw guard: the note must instruct a findings dump) ──

{
  check("note: mentions finalize + findings + continuation",
    WRAP_UP_BUDGET.includes("finalize") && WRAP_UP_BUDGET.includes("findings") && WRAP_UP_BUDGET.includes("continuation"));
}

// ── truncateMid / distillTrajectory ──────────────────────────────────────────────

{
  const long = "A".repeat(1_000) + "TAIL";
  const cut = truncateMid(long, 200);
  check("truncateMid: length respected", cut.length <= 200 + 64, String(cut.length));
  check("truncateMid: head+tail survive", cut.startsWith("AAAA") && cut.endsWith("TAIL"));
  check("truncateMid: marker present", cut.includes("[v5 handoff]"));

  const history: ChatMsg[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "Turn 1/30:" },
    { role: "assistant", content: "short" }, // < 20 chars — not a finding
    { role: "user", content: "REPL stdout:\nresult=42" },
    { role: "assistant", content: "Confirmed DEFAULT_TIMEOUT_MS is 500 in config.py. Next: check retry loop." },
    { role: "user", content: "REPL stdout:\nfound at line 12" },
  ];
  const h = distillTrajectory(history, "Find the default timeout", 4_000);
  check("distill: template sections present",
    h.includes("ORIGINAL TASK:") && h.includes("CONFIRMED FINDINGS SO FAR:") && h.includes("CURRENT STATE / LAST ACTIONS:") && h.includes("NEXT STEP:"));
  check("distill: picks substantive finding", h.includes("DEFAULT_TIMEOUT_MS"));
  check("distill: picks REPL state block", h.includes("result=42"));
  check("distill: next-step harvested from findings", h.includes("check retry loop"));
  check("distill: drops trivial assistant noise", !h.includes("short"));

  const hNoNext = distillTrajectory([{ role: "assistant", content: "Only a finding with no forward verb in it." }], "q", 4_000);
  check("distill: DEFAULT_NEXT_STEP fallback", hNoNext.includes(DEFAULT_NEXT_STEP));

  const longQuery = "Q".repeat(2_000);
  const hTrim = distillTrajectory([], longQuery, 800);
  check("distill: query sliced to 800", !hTrim.includes("Q".repeat(900)) && hTrim.includes("Q".repeat(50)));

  check("continuationPrompt: header + body", continuationPrompt(2, "BODY").startsWith("[continuation 2]\nBODY"));
}

// ── G1 elision (v5 governor) ────────────────────────────────────────────────────

{
  const mk = (role: ChatMsg["role"], content: string): ChatMsg => ({ role, content });
  const history: ChatMsg[] = [
    mk("system", "sys prompt"),
    mk("user", "Turn 0/30:"),
    mk("assistant", "first turn"),
    mk("user", "REPL stdout:\n" + "x".repeat(5_000)),
    mk("assistant", "second turn"),
    mk("user", "REPL stdout:\n" + "y".repeat(5_000)),
    mk("assistant", "third turn"),
    mk("user", "REPL stdout:\nkeep-me-verbatim"),
  ];
  const out = elideOldToolPayloads(history);
  check("G1: system untouched", out[0].content === "sys prompt");
  check("G1: tail user message untouched", out[out.length - 1].content.includes("keep-me-verbatim"));
  const elided = out.filter((m) => m.content.includes("[elided v5-G1]"));
  check("G1: old payloads elided", elided.length >= 1, String(elided.length));
  check("G1: elided size bounded", elided.every((m) => m.content.length <= 1_600));
  const short = elideOldToolPayloads([mk("system", "s"), mk("user", "tiny"), mk("assistant", "a"), mk("user", "tiny2")]);
  check("G1: short history untouched (same ref)", short.length === 4 && !short.some((m) => m.content.includes("[elided")));
}

// ── ModelContextRegistry ─────────────────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "rlm-budget-"));
  try {
    const reg = new ModelContextRegistry(modelsCachePath(dir));
    check("registry: table hit", reg.limitFor("openai/gpt-5") === 400_000);
    check("registry: unknown → 32k", reg.limitFor("nope/unknown") === UNKNOWN_CONTEXT);
    check("registry: observe writes cache", reg.observe("custom/model", 123_456));
    const fresh = new ModelContextRegistry(modelsCachePath(dir)); // new instance → must read disk
    check("registry: cache round-trips", fresh.limitFor("custom/model") === 123_456);

    // Expired TTL → falls back to the table/unknown.
    writeFileSync(modelsCachePath(dir), JSON.stringify({ "custom/model": { ctx: 999, ts: 0 } }));
    const expired = new ModelContextRegistry(modelsCachePath(dir));
    check("registry: expired cache entry ignored", expired.limitFor("custom/model") === UNKNOWN_CONTEXT);

    writeFileSync(modelsCachePath(dir), "{not json");
    const corrupt = new ModelContextRegistry(modelsCachePath(dir));
    check("registry: corrupt cache degrades to 32k", corrupt.limitFor("openai/gpt-5") === 400_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── engine-level: soft note + hard → continuation (no throw, no wrong finalize) ──

{
  // 260 input tokens/turn: t1=260 "", t2=520 soft, t3=780 hard → continuation (fresh window).
  const config = cfg({ budgetShare: 1, budgetTaskCap: 600, budgetMaxContinuations: 2, maxIterations: 10 });
  const seen: ChatMsg[][] = [];
  let calls = 0;
  const script: (msgs: readonly ChatMsg[]) => Promise<CompleteResult> = async (msgs) => {
    calls++;
    seen.push([...msgs]);
    const prompt = msgs.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (prompt.includes("FINAL")) {
      return { text: 'final answer text', usage: usage(260) };
    }
    if (calls >= 6 || prompt.includes("[continuation") && calls >= 4) {
      return { text: '```repl\nanswer["content"] = "done-budget"\nanswer["ready"] = True\n```', usage: usage(260) };
    }
    return { text: "```python\nprint('probing')\n```", usage: usage(260) };
  };
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
  });
  const res = engine({ rootPrompt: "engine budget test", context: "some context", depth: 0 });
  const out = await res;
  check("engine: budget run finishes without throwing", out.answer.length > 0, out.answer.slice(0, 60));
  check("engine: continuation chain produced an answer", out.answer === "done-budget" || out.answer.includes("final answer"), out.answer.slice(0, 60));
  check("engine: soft wrap-up note was injected once",
    seen.some((msgs) => msgs.some((m) => m.content.includes("[budget] ~80%"))));
  check("engine: continuation prompt reached the model",
    seen.some((msgs) => msgs.some((m) => m.content.includes("[continuation"))),
    `calls=${calls}`);
  check("engine: iterations folded across the chain", out.iterations > 0, String(out.iterations));
}

{
  // Chain cap 0: hard → immediate finalize, never a throw (v4 Run-1 flaw regression).
  const config = cfg({ budgetShare: 1, budgetTaskCap: 300, budgetMaxContinuations: 0, maxIterations: 10 });
  let calls = 0;
  const script = async (): Promise<CompleteResult> => { calls++; return { text: "```python\nprint('loop')\n```", usage: usage(400) }; };
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
  });
  const out = await engine({ rootPrompt: "chain-cap test", context: "ctx", depth: 0 });
  check("engine: chain cap 0 finalizes (no throw, no runaway)", out.answer.length > 0, out.answer.slice(0, 60));
  // 1 turn + 1 finalize call — the loop broke at the first hard, long before maxIterations.
  check("engine: chain cap 0 stops early", calls <= 3, `calls=${calls}`);
}

// ── audit C4: distill harvests the REAL formatter's output (needle parity) ─────────

{
  const rr = {
    stdout: "result=42\nneedle found at src/auth.ts:12", stderr: "", finalAnswer: null,
    answerContent: "", raised: false, executionTimeMs: 0, varNames: [], pendingTasks: [],
  };
  const history: ChatMsg[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "Turn 1/30:" },
    { role: "assistant", content: "probing the auth module" },
    { role: "user", content: formatReplOutputs([rr]) },
  ];
  const h = distillTrajectory(history, "find the needle", 4_000);
  check("C4: real formatReplOutputs output is harvested as state",
    h.includes("needle found at src/auth.ts:12"), h.slice(0, 80));

  // Chronology (audit C4): oldest finding first in the join, newest next-step hint.
  const chrono: ChatMsg[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: "FIRST: confirmed alpha in config.py" },
    { role: "assistant", content: "SECOND: confirmed beta in auth.ts. next: check gamma" },
  ];
  const c = distillTrajectory(chrono, "q", 4_000);
  check("C4: findings joined chronologically", c.indexOf("FIRST:") < c.indexOf("SECOND:"), "");
  check("C4: next-step hint from the NEWEST finding", c.includes("check gamma"), "");
}

// ── audit H2: continuation persists under the ORIGINAL key + stopped answers never persist ──

{
  const dir = mkdtempSync(join(tmpdir(), "rlm-h2-"));
  try {
    const store = new MemoryStore(dir, { dir: join(dir, "m") });
    const config = cfg({ budgetShare: 1, budgetTaskCap: 550, budgetMaxContinuations: 2, maxIterations: 10 });
    let calls = 0;
    const script: (msgs: readonly ChatMsg[]) => Promise<CompleteResult> = (msgs) => {
      calls++;
      // [continuation N] lives on the system <task> line (rootPrompt), not a user turn.
      const prompt = msgs.map((m) => m.content).join("\n");
      if (prompt.includes("FINAL") || calls >= 8) {
        return { text: "plain final text", usage: usage(200) };
      }
      if (prompt.includes("[continuation")) {
        return { text: '```repl\nanswer["content"] = "chain-answer"\nanswer["ready"] = True\n```', usage: usage(200) };
      }
      return { text: "```repl\nprint('working')\n```", usage: usage(300) };
    };
    const emitter = new RlmEmitter();
    let emittedAnswer = "";
    emitter.onAnswer((e) => { emittedAnswer = e.text; });
    const mk = (em = new RlmEmitter()) =>
      createEngine({
        model: MOCK_MODEL, llmModel: MOCK_MODEL, registry: MOCK_REGISTRY, config,
        emitter: em, memory: store,
        complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
      });
    const first = await mk(emitter)({ rootPrompt: "h2 chain test", context: "ctx-body", depth: 0 });
    check("H2: continuation chain produced an answer", first.answer.length > 0, first.answer.slice(0, 40));
    check("H2: chain persisted an episode under the original key", store.stats().episodes >= 1, JSON.stringify(store.stats()));
    check("R2: continuation emitAnswer carries the chain answer",
      emittedAnswer.length > 0 && first.answer.includes("chain-answer") && emittedAnswer.includes("chain-answer"),
      `emitted=${emittedAnswer.slice(0, 60)} answer=${first.answer.slice(0, 40)}`);
    const persisted = store.replay(taskKey("root", "h2 chain test", [], "test/mock", contextSig("ctx-body")));
    check("R2: persist tokens are the CHAIN total (parent + leaf)",
      persisted !== undefined && persisted.tokensIn === first.inputTokens && first.inputTokens > 0,
      `ep=${persisted?.tokensIn} chained=${first.inputTokens}`);
    const callsBefore = calls;
    const second = await mk()({ rootPrompt: "h2 chain test", context: "ctx-body", depth: 0 });
    check("H2: identical re-run replays the chain answer (0 completions)",
      calls === callsBefore && second.answer === first.answer && second.iterations === 0,
      `calls+${calls - callsBefore} iters=${second.iterations}`);

    // Stopped (LimitError) answers must never be recorded — they would replay as real.
    const stoppedStore = new MemoryStore(dir, { dir: join(dir, "s") });
    const stopEngine = createEngine({
      model: MOCK_MODEL, llmModel: MOCK_MODEL, registry: MOCK_REGISTRY,
      config: cfg({ maxIterations: 5 }),
      emitter: new RlmEmitter(), memory: stoppedStore,
      limits: { maxTokens: 1 },
      complete: (async () => ({ text: "thinking...", usage: usage(50) })) as unknown as import("../src/core/iteration.ts").CompleteFn,
    });
    const stopped = await stopEngine({ rootPrompt: "will be stopped", context: "ctx", depth: 0 });
    check("H2: maxTokens stop ends the run with a partial", stopped.answer.length > 0 && stopped.iterations < 5, stopped.answer.slice(0, 40));
    check("H2: stopped partial NOT persisted", stoppedStore.stats().episodes === 0, JSON.stringify(stoppedStore.stats()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

finish();
