/**
 * Root Σ v2 R6 (G5) — O(T) proof: per-call context chars with the Root Σ transform OFF vs ON.
 *
 * Drives N synthetic turns through the REAL transforms (elideStalePayloads + spliceSigmaSnapshot
 * with the R2 contract) over a near-cap Σ, then asserts the complexity contract:
 *   - OFF (baseline, = RLM_BENCH_NO_ROOTCONTEXT arm): per-call context grows monotonically
 *     with the turn index — cumulative cost is O(T²) (Pi re-sends the full array every call).
 *   - ON (enforced Root Σ v2): per-call context is FLAT past the window — bounded by
 *     P + Ξ + Σ (≤ bytesTotal) + keepTurns · (turn payload cap).
 *   - κ_Σ adherence: the spliced Σ never exceeds RUN_STATE_LIMITS.bytesTotal.
 *
 * The curve table prints to stdout and lands in /tmp/root-sigma-token-bench.txt (fail-soft).
 *
 * Run: bun run pi-plugin/rlm/test/phase-root-tokens.ts
 */

import { writeFileSync } from "node:fs";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { check, finish } from "./helpers.ts";
import { elideStalePayloads, spliceSigmaSnapshot, type RootMessage } from "../src/core/root-context.ts";
import { RootStateTracker } from "../src/core/root-state.ts";
import { RUN_STATE_LIMITS } from "../src/core/run-state.ts";
import { textContentOf } from "../src/text/agent-text.ts";

type Msg = ContextEvent["messages"][number];

const TURNS = 12;
const PROSE = "p".repeat(4_000); // per-turn assistant payload (worst-case verbose turns)
const TOOL = "t".repeat(4_000); // per-turn tool payload

function user(text: string): Msg {
  return { role: "user", content: text, timestamp: 1 } as Msg;
}
function assistant(text: string): Msg {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "t",
    model: "m", usage: {}, stopReason: "stop",
  } as unknown as Msg;
}
function toolResult(text: string): Msg {
  return {
    role: "toolResult", toolCallId: `t-${Math.random()}`, toolName: "read",
    content: [{ type: "text", text }], isError: false,
  } as Msg;
}

/** A t-turn conversation: [original ask, (assistant + toolResult + user) × t]. */
function conversation(turns: number): RootMessage[] {
  const messages: RootMessage[] = [user("original ask — audit the retry path")];
  for (let i = 0; i < turns; i++) {
    messages.push(assistant(`turn ${i} prose ${PROSE}`));
    messages.push(toolResult(`turn ${i} payload ${TOOL}`));
    messages.push(user(`follow-up ${i}`));
  }
  return messages;
}

function charsOf(messages: readonly RootMessage[]): number {
  let total = 0;
  for (const m of messages) total += textContentOf((m as { content?: unknown }).content).length;
  return total;
}

// ── Σ near the cap: pump the tracker until evictions kick in, prove κ_Σ adherence ──
const tracker = RootStateTracker.fresh("token bench — near-cap Σ");
for (let i = 0; i < 40; i++) {
  tracker.noteFact(`facts/mod${i}.ts — verified fact number ${i} with enough body to be a real grounding line`);
  tracker.noteFinding(`finding number ${i}: the retry table and the cooldown window interact through util/retry.ts`);
}
const sigma = tracker.snapshot();
const sigmaBytes = JSON.stringify(sigma).length;
check("κ_Σ: Σ never exceeds bytesTotal (12 000)", sigmaBytes <= RUN_STATE_LIMITS.bytesTotal, `${sigmaBytes} bytes`);

// ── drive both arms ──
const offChars: number[] = new Array<number>(TURNS);
const onChars: number[] = new Array<number>(TURNS);
let totalElided = 0;
let totalSplices = 0;
let badSplices = 0;
for (let t = 1; t <= TURNS; t++) {
  const base = conversation(t);
  offChars[t - 1] = charsOf(base);

  const clone: RootMessage[] = [...base]; // the transform mutates its clone (host contract)
  totalElided += elideStalePayloads(clone, { keepTurns: 2, elideChars: 1_500 });
  spliceSigmaSnapshot(clone, sigma, undefined, { withContract: true });
  totalSplices += 1;
  const spliced = clone.filter((m) => (m as { customType?: string }).customType === "rlm-sigma");
  if (spliced.length !== 1) badSplices += 1;
  onChars[t - 1] = charsOf(clone);
}
check("exactly one Σ splice per call", badSplices === 0, `${badSplices} bad calls`);

// ── the curve ──
const rows: string[] = ["  t   OFF chars   ON chars"];
for (let t = 0; t < TURNS; t++) {
  rows.push(`${String(t + 1).padStart(3)}  ${String(offChars[t] ?? 0).padStart(9)}  ${String(onChars[t] ?? 0).padStart(8)}`);
}
const table = rows.join("\n");
console.log(`\n${table}`);

const cumulative = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0);
const cumOff = cumulative(offChars);
const cumOn = cumulative(onChars);
const lastOff = offChars[TURNS - 1] ?? 0;
const lastOn = onChars[TURNS - 1] ?? 0;

// ── OFF arm: monotonic growth (the O(T²) profile Pi ships by default) ──
check("OFF: per-call context grows monotonically", offChars.every((v, i) => i === 0 || v > (offChars[i - 1] ?? 0)));
// Quadratic cumulative ⇒ cumOff / lastOff ≈ T/2; anything ≥ T/3 still proves the growth isn't flat.
check("OFF cumulative is superlinear vs the final call", cumOff > lastOff * (TURNS / 3), `${cumOff} vs ${lastOff}×${(TURNS / 3).toFixed(1)}`);

// ── ON arm: flat past the window (t ≥ 3 calls are all steady-state) ──
const steadyOn = onChars.slice(2);
const steadyMax = Math.max(...steadyOn);
const steadyMin = Math.min(...steadyOn);
check("ON: per-call context is flat past the window", steadyMax - steadyMin < 3_000, `spread ${steadyMax - steadyMin}`);
check("ON: final call is a small fraction of the OFF final call", lastOn < lastOff / 3, `${lastOn} vs ${lastOff}`);
check("ON: cumulative stays well under the OFF cumulative", cumOn < cumOff / 2, `${cumOn} vs ${cumOff}`);
check("transform actually elided payloads", totalElided > 0, `${totalElided} elisions`);
check("every call carried its Σ splice", totalSplices === TURNS);

// ── bounded by the contract: Σ (≤ κ_Σ) + 2 protected turns · (prose + verbatim in-window
// payload) + the 2-turn preview ring · elideChars + per-stale-turn stubs + contract + users ──
const turnCap = PROSE.length + TOOL.length + 128; // "turn N prose/payload " prefixes + slack
const bound = RUN_STATE_LIMITS.bytesTotal + 2 * turnCap + 2 * 1_600 + TURNS * 176 + 1_200;
check("ON: steady-state bounded by Σ + window + preview ring + stubs", steadyMax < bound, `${steadyMax} < ${bound}`);

// ── /tmp summary (fail-soft — measurement, not assertion) ──
try {
  writeFileSync(
    "/tmp/root-sigma-token-bench.txt",
    `Root Σ v2 R6 — per-call context chars (OFF vs ON), TURNS=${TURNS}\n` +
    `Σ bytes=${sigmaBytes} (cap ${RUN_STATE_LIMITS.bytesTotal})\n${table}\n` +
    `cumulative OFF=${cumOff} ON=${cumOn}\n`,
  );
} catch {
  // no /tmp, no problem
}

finish();
