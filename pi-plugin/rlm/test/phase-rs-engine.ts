/**
 * SKILL.state Workstream A — engine loop with ```state fences: Σ advances and reaches the
 * next prompt (A_t = (P, Σ_t, O_t)); structural compaction replaces the LLM summary path
 * (zero summarizer calls); rejections surface as observations; disabled/narrative runs stay
 * byte-for-byte as-built.
 * Run: bun run pi-plugin/rlm/test/phase-rs-engine.ts
 */

import { createEngine } from "../src/core/engine.ts";
import { COMPACTION_CEILING_TOKENS } from "../src/core/limits.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RlmConfig } from "../src/core/types.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { captureComplete, check, finish, MOCK_MODEL, MOCK_REGISTRY, repl, runSuite } from "./helpers.ts";

function cfg(over: Partial<RlmConfig> = {}): RlmConfig {
  return { ...DEFAULT_CONFIG, enableLedger: false, ...over };
}

const FACT = "src/retry.ts — backoff lives here";

// Committed at turn 0: repl block + a valid state fence.
const RESP0 = [
  "Looking at the retry module.",
  repl('print("probe")'),
  "```state",
  JSON.stringify({ state_patch: { "verifiedFacts[+]": FACT, nextStep: "read backoff loop" } }),
  "```",
].join("\n");

// Turn 1: a deliberately rejected patch (unknown field) — must roll back + observe.
// Padded past the ABSOLUTE COMPACTION_CEILING_TOKENS (shouldCompact no longer reads
// compactionThresholdPct — LO rule 2025-09-09), so the rebase arm must reach the ceiling by
// mass instead of by config. Derived from the constant (≈4 chars/token + 25% slack) so this
// suite keeps working when the ceiling is re-tuned — it broke once at the 256k→1M change.
const PAD = "filler ".repeat(Math.ceil((COMPACTION_CEILING_TOKENS * 4 * 1.25) / 7));
const RESP1 = [
  repl("print(2)"),
  PAD,
  "```state",
  JSON.stringify({ state_patch: { bogus: 1 } }),
  "```",
].join("\n");

// Turn 2: finalize.
const RESP2 = repl('answer["content"] = "done"\nanswer["ready"] = True');

function allMessages(calls: ReturnType<typeof captureComplete>["calls"]): string {
  return calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
}

async function drive(config: RlmConfig, input: { narrative?: boolean; depth?: number } = {}) {
  const captured = captureComplete([RESP0, RESP1, RESP2]);
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    complete: captured.complete,
  });
  const result = await engine({ rootPrompt: "find the backoff policy", context: "ctx", depth: 0, ...input });
  return { result, calls: captured.calls };
}

async function main(): Promise<void> {
  // ── active: Σ advances, reaches the prompt, rejections observed, structural rebase ──
  {
    const { result, calls } = await drive(cfg({ compaction: true, compactionThresholdPct: 0.0001 }));
    check("run finalizes", result.answer === "done");
    check("three model turns", calls.length === 3, String(calls.length));

    const last = calls[2].messages.at(-1)?.content ?? "";
    check("Σ reaches the turn prompt from iteration 3", last.includes("[Σ]"));
    check("committed fact visible in Σ", last.includes(FACT));
    check("state fence requested from iteration 3", last.includes("```state"));
    check("rejection observed as next O_t prefix", last.includes("state patch rejected"));

    const everything = allMessages(calls);
    check("structural rebase ran (no summarizer)", everything.includes("structurally rebased"));
    check("zero summary requests through the model", !everything.includes("Summarize your progress so far"));
    // Cold-start gate (§12.2) is about the fence REQUEST: not asked before iteration 3.
    // (Σ itself may land early via structural rebase when the threshold is tiny — production
    // thresholds never fire on an empty history.)
    check("cold start: turn 1 gets no fence request", !(calls[0].messages.at(-1)?.content ?? "").includes("[state]"));
    check("cold start: turn 2 gets no fence request", !(calls[1].messages.at(-1)?.content ?? "").includes("[state]"));
  }

  // ── disabled: byte-for-byte as-built behavior ──
  {
    const { calls } = await drive(cfg({ enableRunState: false, compaction: false }));
    const everything = allMessages(calls);
    check("disabled: no Σ injection", !everything.includes("[Σ]"));
    check("disabled: no fence instruction", !everything.includes("[state]"));
    check("disabled: patches ignored (no rejection text)", !everything.includes("state patch rejected"));
  }

  // ── narrative (history-as-deliverable): RunState never activates ──
  {
    const { calls } = await drive(cfg({ compaction: false }), { narrative: true });
    const everything = allMessages(calls);
    check("narrative: no Σ injection", !everything.includes("[Σ]"));
    check("narrative: no fence instruction", !everything.includes("[state]"));
  }

  finish();
}

runSuite(main);
