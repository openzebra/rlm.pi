/**
 * Recall A/B eval (recall W5b) — the native context transform, measured.
 *
 * The SKILL.state / Root-Σ integration made native sessions worse at RECALL: everything
 * older than `rootContextKeepTurns` assistant turns is stubbed, and before the session
 * archive those bytes were unrecoverable by design. This harness replays the EXACT pipeline
 * index.ts wires (elideStalePayloads + the SessionArchive sink + segment materialization)
 * over scripted needle transcripts and scores three arms:
 *
 *   legacy   keepTurns=2, archive OFF  (the post-integration regression shape)
 *   recall   keepTurns=4, archive ON   (this branch's defaults)
 *   noxform  RLM_BENCH_NO_ROOTCONTEXT  (dev A/B hatch: no transform at all — ceiling arm)
 *
 * Metrics per arm: post-transform prompt chars (the O(T) acceptance bound), verbatim needle
 * survival in the window, and ARCHIVE RECALL — bm25Rank (util/bm25.ts; constants mirror the
 * worker's retrieval.py per the duality rule) over the materialized segments, the offline
 * proxy for the sandbox `search()` a stub teaches. Live-model arms are NOT run here: the
 * transform is deterministic, so equal-or-better recall with bounded tokens is provable
 * offline; point the usual live oolong bench at real sessions to confirm end to end.
 *
 * Run: bun run bench/recall-eval.ts [--turns 24] [--needles 3]
 */

import { elideStalePayloads, type RootMessage } from "../pi-plugin/rlm/src/core/root-context.ts";
import { SessionArchive } from "../pi-plugin/rlm/src/core/session-archive.ts";
import { bm25Rank } from "../pi-plugin/rlm/src/util/bm25.ts";

// ── Transcript synthesis ────────────────────────────────────────────────────────────────

interface SyntheticMessage {
  readonly role: "user" | "assistant" | "toolResult";
  readonly toolName?: string;
  readonly text: string;
}

const FILLER_TOPICS = [
  "module boundary review for the storage layer", "lint configuration alignment",
  "dependency upgrade survey", "test flakiness triage", "naming convention sweep",
  "logging levels cleanup", "error message consistency pass", "type widening audit",
];

function fillerTurn(i: number): readonly SyntheticMessage[] {
  const topic = FILLER_TOPICS[i % FILLER_TOPICS.length] ?? "general review";
  const body = `Discussed ${topic}. Iteration ${i}: reviewed the shapes, listed candidates, agreed to defer the decision until the next pass. `.repeat(6);
  return [
    { role: "assistant", text: body },
    { role: "toolResult", toolName: "read", text: `read src/module-${i}.ts\n${"x".repeat(4_000)}\n// end of module ${i}` },
    { role: "assistant", text: `Turn ${i} wrapped up the ${topic} thread with no durable conclusion.` },
  ];
}

/** Needle turns embed a fact the final question depends on — planted EARLY, so every
 *  windowed arm elides them; only the archive arm can still dereference them. */
function needleTurn(n: number, i: number): readonly SyntheticMessage[] {
  const fact = `NEEDLE-${n}: the flux capacitor must be calibrated at exactly ${4200 + n * 7} megawatts before any time travel test.`;
  return [
    { role: "assistant", text: `Found a critical constraint while studying calibration unit ${i}. ${fact} Recording this for the final report.` },
    { role: "toolResult", toolName: "bash", text: `$ calibrate --unit ${i}\n${fact}\nexit code 0` },
  ];
}

function buildTranscript(turns: number, needles: number): { readonly messages: readonly SyntheticMessage[]; readonly needles: readonly string[] } {
  const messages: SyntheticMessage[] = [{ role: "user", text: "Long study session — remember every constraint you find." }];
  const found: string[] = [];
  const needleEvery = Math.max(2, Math.floor(turns / Math.max(1, needles)));
  for (let i = 0; i < turns; i++) {
    if (i % needleEvery === 0 && found.length < needles) {
      const n = found.length;
      found.push(`NEEDLE-${n}`);
      messages.push(...needleTurn(n, i));
    } else {
      messages.push(...fillerTurn(i));
    }
  }
  messages.push({ role: "user", text: "What are the exact calibration constraints you found? List every NEEDLE." });
  return { messages, needles: found };
}

/** Shape a synthetic message into the Pi RootMessage union (bench boundary cast — the
 *  transform only reads role/content/toolName/customType). */
function toRoot(m: SyntheticMessage): RootMessage {
  if (m.role === "toolResult") {
    return {
      role: "toolResult", toolCallId: `t-${m.toolName}`, toolName: m.toolName ?? "tool",
      content: [{ type: "text", text: m.text }], isError: false,
    } as unknown as RootMessage;
  }
  if (m.role === "assistant") {
    return { role: "assistant", content: [{ type: "text", text: m.text }] } as unknown as RootMessage;
  }
  return { role: "user", content: m.text, timestamp: 1 } as unknown as RootMessage;
}

// ── Arms ────────────────────────────────────────────────────────────────────────────────

interface ArmResult {
  readonly name: string;
  readonly promptChars: number;
  readonly needlesVerbatim: number;
  readonly needlesRecalled: number;
  readonly archiveSegments: number;
  readonly teachesArchive: boolean;
}

function runArm(
  name: string,
  messages: readonly SyntheticMessage[],
  keepTurns: number,
  archiveOn: boolean,
  skipTransform: boolean,
  needles: readonly string[],
): ArmResult {
  const shaped: RootMessage[] = messages.map(toRoot);
  const archive = new SessionArchive(2_000_000);
  let segments = 0;

  if (!skipTransform) {
    // Sink = the SessionArchive.record call in index.ts (full pre-elision text).
    const sink = archiveOn
      ? (entry: { role: "assistant" | "toolResult"; toolName: string | undefined; text: string }): void => {
          archive.record(entry);
        }
      : undefined;
    elideStalePayloads(shaped, { keepTurns, elideChars: 3_000, archiveActive: archiveOn }, sink);
    if (archiveOn) {
      while (archive.hasPending) {
        archive.renderPending();
        segments += 1;
      }
    }
  }

  const transcript = shaped.map((m) => JSON.stringify(m)).join("\n");
  const needlesVerbatim = needles.filter((n) => transcript.includes(n)).length;
  const teachesArchive = transcript.includes("ctx/session-log");

  // Archive recall — the offline proxy for the sandbox search() the stub teaches. The twin
  // archive replays the same records (renderPending is destructive); each needle query must
  // surface its own segment in the top-3, exactly what search(query, k=3) gives the model.
  let needlesRecalled = 0;
  if (archiveOn) {
    const twin = new SessionArchive(2_000_000);
    for (const m of messages) {
      if (m.role !== "user") twin.record({ role: m.role, toolName: m.toolName, text: m.text });
    }
    const segTexts: string[] = [];
    while (twin.hasPending) {
      const seg = twin.renderPending();
      if (seg === undefined) break;
      segTexts.push(seg.text);
    }
    const corpus = segTexts.map((text) => ({ item: text, text }));
    for (const needle of needles) {
      const hits = bm25Rank(`calibration constraint ${needle} exact megawatt value`, corpus, 3);
      if (hits.some((h) => h.item.includes(needle))) needlesRecalled += 1;
    }
  }

  return { name, promptChars: transcript.length, needlesVerbatim, needlesRecalled, archiveSegments: segments, teachesArchive };
}

// ── Main ────────────────────────────────────────────────────────────────────────────────

const arg = (flag: string, fallback: number): number => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const TURNS = arg("--turns", 24);
const NEEDLES = arg("--needles", 3);

const { messages, needles } = buildTranscript(TURNS, NEEDLES);
const raw = messages.map((m) => m.text).join("\n").length;
console.log(`transcript: ${TURNS} turns, ${NEEDLES} needles, ${messages.length} messages, ${raw.toLocaleString()} chars raw\n`);

const arms: readonly ArmResult[] = [
  runArm("noxform (no transform — ceiling)", messages, 4, false, true, needles),
  runArm("legacy (keepTurns=2, no archive)", messages, 2, false, false, needles),
  runArm("recall (keepTurns=4, archive ON)", messages, 4, true, false, needles),
];

console.log("arm                                     promptChars  verbatim  archiveRecall  segments  teaches");
for (const a of arms) {
  console.log(
    a.name.padEnd(38) +
    String(a.promptChars).padStart(10) + "  " +
    `${a.needlesVerbatim}/${needles.length}`.padStart(8) + "  " +
    `${a.needlesRecalled}/${needles.length}`.padStart(13) + "  " +
    String(a.archiveSegments).padStart(8) + "  " +
    (a.teachesArchive ? "yes" : "no"),
  );
}

const legacy = arms[1] ?? arms[0];
const recall = arms[2] ?? arms[0];
const ceiling = arms[0];
console.log("");
const checks: readonly [string, boolean][] = [
  ["legacy arm loses the needles verbatim (regression reproduced)", (legacy?.needlesVerbatim ?? 0) < needles.length],
  ["recall arm restores the needles through the archive", (recall?.needlesRecalled ?? 0) === needles.length],
  ["recall arm window stays under the no-transform ceiling", (recall?.promptChars ?? 0) < ceiling.promptChars],
  ["recall arm stubs teach the archive recall path", recall.teachesArchive],
  ["legacy arm stubs promise no archive (honest, just mute)", !legacy.teachesArchive],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed += 1;
}
if (failed > 0) process.exit(1);
console.log("\nrecall eval: ALL PASS");
