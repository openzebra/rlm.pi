/**
 * Root Σ WS-2 — buildRootDigestCompaction: deterministic, no-LLM root compaction.
 * Cut-point tightening, section build/order, cap drop-order, fail-soft on garbage.
 * Run: bun run pi-plugin/rlm/test/phase-root-digest.ts
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildRootDigestCompaction, type RootDigestPreparation } from "../src/core/root-digest.ts";
import { check, finish } from "./helpers.ts";

const CONFIG = {
  rootDigestKeepRecentChars: 12_000,
  rootDigestMaxChars: 8_000,
  skillStateMinScore: 4.0,
};

let entrySeq = 0;
function msgEntry(role: string, text: string, extra: Record<string, unknown> = {}): SessionEntry {
  entrySeq += 1;
  return {
    id: `e${entrySeq}`,
    parentId: null,
    timestamp: new Date(2026, 0, 1, 12, entrySeq).toISOString(),
    type: "message",
    message: { role, content: role === "user" ? text : [{ type: "text", text }], timestamp: entrySeq, ...extra },
  } as SessionEntry;
}

function toolEntry(toolName: string, text: string): SessionEntry {
  entrySeq += 1;
  return {
    id: `e${entrySeq}`,
    parentId: null,
    timestamp: new Date(2026, 0, 1, 12, entrySeq).toISOString(),
    type: "message",
    message: {
      role: "toolResult", toolCallId: `t${entrySeq}`, toolName,
      content: [{ type: "text", text }], isError: false,
    },
  } as SessionEntry;
}

function prep(partial: Partial<RootDigestPreparation>): RootDigestPreparation {
  return {
    firstKeptEntryId: "",
    messagesToSummarize: [],
    isSplitTurn: false,
    tokensBefore: 1234,
    ...partial,
  };
}

const BIG = "x".repeat(3_000);

{
  // ── degenerate inputs → undefined (Pi keeps its own path) ──
  check(
    "empty span ⇒ undefined",
    buildRootDigestCompaction({
      preparation: prep({ firstKeptEntryId: "keep-1", messagesToSummarize: [] }),
      branchEntries: [],
      config: CONFIG,
      store: undefined,
    }) === undefined,
  );
  check(
    "split turn ⇒ undefined",
    buildRootDigestCompaction({
      preparation: prep({ isSplitTurn: true, messagesToSummarize: [{ role: "user", content: "hi" }] }),
      branchEntries: [],
      config: CONFIG,
      store: undefined,
    }) === undefined,
  );
}

{
  // ── the basic digest: sections present, Pi's boundary untouched when the tail fits ──
  const entries: SessionEntry[] = [
    msgEntry("user", "audit the retry path in the worker"),
    msgEntry("assistant", `I located the retry loop and confirmed the backoff table. ${BIG}`),
    toolEntry("grep", "match at util/retry.ts:41 — retryBaseDelayMs"),
    msgEntry("user", "next: verify the cooldown window"),
  ];
  const piCutId = entries[0].id;
  const result = buildRootDigestCompaction({
    preparation: prep({
      firstKeptEntryId: piCutId,
      messagesToSummarize: [
        { role: "user", content: "audit the retry path in the worker" },
        { role: "assistant", content: [{ type: "text", text: `I located the retry loop and confirmed the backoff table. ${BIG}` }] },
        { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "match at util/retry.ts:41 — retryBaseDelayMs" }] },
        { role: "user", content: "next: verify the cooldown window" },
      ],
    }),
    branchEntries: entries,
    config: CONFIG,
    store: undefined,
  });
  const compaction = result?.compaction;
  check("digest produced", compaction !== undefined);
  if (compaction) {
    check("header present", compaction.summary.includes("[Root digest"));
    check("[Task] is the last user prompt", compaction.summary.includes("[Task] next: verify the cooldown window"));
    check("[Findings] carries the assistant blob", compaction.summary.includes("[Findings] - I located the retry loop"));
    check("[State] carries the tool line", compaction.summary.includes("grep: match at util/retry.ts:41"));
    check("[Next] mirrors distillTrajectory probe", compaction.summary.includes("[Next]"));
    check("details marker", (compaction.details as { kind?: string }).kind === "root-digest");
    check("tokensBefore passes through", compaction.tokensBefore === 1234);
    check("V1 probe: recomputed token estimate is positive", result.tokensBeforeRecomputed > 0,
      String(result.tokensBeforeRecomputed));
    // Tail fits the 12K budget ⇒ Pi's own cut stands (never extend).
    check("no tighten when tail fits", compaction.firstKeptEntryId === piCutId);
  }
}

{
  // ── tightening: small budget ⇒ later cut, displaced entries folded into the digest ──
  const entries: SessionEntry[] = [
    msgEntry("user", "old ask one"),
    toolEntry("read", `OLD-READ-PAYLOAD ${BIG}`),
    msgEntry("assistant", `findings blob for the record ${BIG}`),
    msgEntry("user", "recent ask two"),
  ];
  const piCutId = entries[0].id;
  const result = buildRootDigestCompaction({
    preparation: prep({
      firstKeptEntryId: piCutId,
      messagesToSummarize: [{ role: "user", content: "old ask one" }],
    }),
    branchEntries: entries,
    config: { ...CONFIG, rootDigestKeepRecentChars: 200 },
    store: undefined,
  });
  const compaction = result?.compaction;
  check("tightened digest produced", compaction !== undefined);
  if (compaction) {
    check("cut moved later", compaction.firstKeptEntryId !== piCutId);
    check("displaced toolResult folded into [State]", compaction.summary.includes("read: OLD-READ-PAYLOAD"));
    check("displaced user folded into nothing fatal", compaction.summary.length > 0);
  }
}

{
  // ── cap: tiny maxChars drops sections in continuity order and keeps the summary bounded ──
  const messages = [
    { role: "user", content: "the task at hand" },
    { role: "assistant", content: [{ type: "text", text: `finding A ${BIG}` }] },
    { role: "assistant", content: [{ type: "text", text: `finding B ${BIG}` }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: `state line ${BIG}` }] },
  ];
  const result = buildRootDigestCompaction({
    preparation: prep({ firstKeptEntryId: "k", messagesToSummarize: messages }),
    branchEntries: [],
    config: { ...CONFIG, rootDigestMaxChars: 600 },
    store: {
      sliceForPrompt: (_q, _budget, _min) => `FACTS-LINE-${"f".repeat(2_000)}`,
    },
  });
  const compaction = result?.compaction;
  check("capped digest produced", compaction !== undefined);
  if (compaction) {
    check("summary bounded by maxChars", compaction.summary.length <= 600 + 64, `${compaction.summary.length}`);
    check("facts dropped first", !compaction.summary.includes("FACTS-LINE"));
    check("task survives trivia", compaction.summary.includes("[Task] the task at hand"));
  }
}

{
  // ── facts section renders from the store slice when within budget ──
  const result = buildRootDigestCompaction({
    preparation: prep({
      firstKeptEntryId: "k",
      messagesToSummarize: [{ role: "user", content: "plan the sandbox split" }],
    }),
    branchEntries: [],
    config: CONFIG,
    store: { sliceForPrompt: () => "- (symbol) worker.py hosts the protocol machinery" },
  });
  check(
    "[Project facts] from the store",
    result?.compaction.summary.includes("[Project facts] - (symbol) worker.py hosts the protocol machinery") === true,
  );
}

{
  // ── garbage input never throws ──
  const garbage = [null, 42, { role: "user" }, { role: "assistant", content: [{ type: "nonsense" }] }, "strange"];
  const result = buildRootDigestCompaction({
    preparation: prep({ firstKeptEntryId: "k", messagesToSummarize: garbage }),
    branchEntries: [{ id: "k", parentId: null, timestamp: "", type: "session_info" } as unknown as SessionEntry],
    config: CONFIG,
    store: undefined,
  });
  check("garbage span still yields a digest (or undefined) without throwing", result !== undefined || true);
}

finish();
