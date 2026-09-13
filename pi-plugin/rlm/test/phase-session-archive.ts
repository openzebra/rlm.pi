/**
 * Recall W1/W2 — the session archive: elision becomes dereferenceable.
 *
 * The elision stubs replaced destroyed turns with one-liners promising channels that never
 * held the bytes (native read/bash payloads never lived in the repl sandbox; the session
 * log is host-side only). SessionArchive records every elided message and materializes it
 * into the sandbox under ctx/session-log/ so the EXISTING free search()/grep_context()
 * recall it. This suite pins the archive mechanics AND the end-to-end chain
 * (record → renderPending → SandboxManager.upsertArchiveSegment → worker BM25).
 * Run: bun run pi-plugin/rlm/test/phase-session-archive.ts
 */

import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, finish, runSuite } from "./helpers.ts";
import { SessionArchive, ARCHIVE_NAMESPACE } from "../src/core/session-archive.ts";
import { SandboxManager } from "../src/sandbox/sandbox-manager.ts";
import { findStatePatches, stripStateFences } from "../src/text/parsing.ts";
import { applyPatch } from "../src/core/run-state.ts";
import { buildRootDigestCompaction } from "../src/core/root-digest.ts";
import { NEXT_STEP_RE } from "../src/core/budget.ts";

function unit(): void {
  const a = new SessionArchive(1_000_000);
  check("empty archive has nothing pending", !a.hasPending && a.renderPending() === undefined);

  const s1 = a.record({ role: "assistant", toolName: undefined, text: "plan: refactor the retry ladder" });
  const s2 = a.record({ role: "toolResult", toolName: "read", text: "export function backoff() {…}" });
  check("records get increasing seqs", s1 === 1 && s2 === 2, `${s1},${s2}`);
  check("pending after records", a.hasPending && a.pendingCharsValue > 0);

  const dup = a.record({ role: "assistant", toolName: undefined, text: "plan: refactor the retry ladder" });
  check("duplicate (re-elided) record is dropped", dup === undefined);

  const seg = a.renderPending();
  check("segment path under the archive namespace", seg?.path.startsWith(ARCHIVE_NAMESPACE) === true, seg?.path);
  check("segment path embeds the covered range", seg?.path === `${ARCHIVE_NAMESPACE}turn-1-2.md`, seg?.path);
  check("segment labels roles and tools", (seg?.text.includes("### turn 1 — assistant") ?? false) && (seg?.text.includes("### turn 2 — toolResult (read)") ?? false));
  check("segment carries the full pre-elision text", (seg?.text.includes("refactor the retry ladder") ?? false) && (seg?.text.includes("backoff") ?? false));
  check("renderPending marks materialized", !a.hasPending && a.renderPending() === undefined);

  // Ring cap: oldest entries drop first; dropping a MATERIALIZED entry is silent, dropping
  // a pending one is counted so the next segment can say so honestly.
  const tiny = new SessionArchive(120);
  tiny.record({ role: "assistant", toolName: undefined, text: "x".repeat(100) });
  tiny.renderPending();
  tiny.record({ role: "assistant", toolName: undefined, text: "y".repeat(100) });
  check("over-cap ring evicts the oldest entry", tiny.stats.entries === 1 && tiny.stats.chars === 100, JSON.stringify(tiny.stats));

  // Per-record truncation: a huge payload is archived head+tail, never whole.
  const big = new SessionArchive(10_000_000);
  big.record({ role: "toolResult", toolName: "bash", text: "A".repeat(300_000) });
  const seg2 = big.renderPending();
  check("oversized record is mid-truncated into the segment", (seg2?.text.length ?? 0) < 150_000 && seg2?.text.includes("chars archived out") === true);

  // Empty text is a no-op (immune/custom messages the caller filters never reach here).
  check("empty text not recorded", a.record({ role: "assistant", toolName: undefined, text: "   " }) === undefined);
}

async function endToEnd(): Promise<void> {
  // The full W1 chain against a REAL Python worker: manager → upsertArchiveSegment →
  // ctx/session-log/* → search() recall (the model-facing path a stub teaches).
  const manager = new SandboxManager({
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    sandboxInitTimeoutMs: 30_000,
    maxPromptChars: 100_000,
    awaitTimeoutS: 30,
  });
  try {
    await manager.getOrCreate({});
    const archive = new SessionArchive(1_000_000);
    archive.record({
      role: "toolResult",
      toolName: "read",
      text: "pricing decision — the enterprise tier ships at $49 per seat with a 20% annual discount floor.",
    });
    archive.record({
      role: "assistant",
      toolName: undefined,
      text: "Decided: the auth refactor lands behind the CANARY_AUTH feature flag; rollout only after the soak passes.",
    });
    const seg = archive.renderPending();
    if (seg === undefined) {
      check("segment rendered for the end-to-end leg", false);
      return;
    }
    const cwd = mkdtempSync(join(tmpdir(), "rlm-archive-"));
    try {
      const written = await manager.upsertArchiveSegment(seg.path, seg.text, cwd);
      check("segment materialized into the live worker", written);
      // The recall the stub teaches: free BM25 over the archive namespace.
      const r = await manager.exec(`import json\nhits = search("enterprise tier pricing", k=3, path_glob="${ARCHIVE_NAMESPACE}*")\nprint(json.dumps([h["path"] for h in hits]))`);
      const paths: unknown = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "[]");
      check("search() recalls the elided payload", Array.isArray(paths) && paths.some((p) => p === seg.path), JSON.stringify(paths));
      const g = await manager.exec(`import json\nhits = grep_context("CANARY_AUTH", path_glob="${ARCHIVE_NAMESPACE}*")\nprint(json.dumps(hits["total"]))`);
      check("grep_context() recalls elided prose", JSON.parse(g.stdout.trim().split("\n").at(-1) ?? "0") === 1);
      // Death-recreate replay: the host snapshot must carry the archive into a fresh worker.
      check("host snapshot replays the archive", Array.isArray(manager.contextPayload) && manager.contextPayload.length >= 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    await manager.dispose();
  }
}

function fencesAndContract(): void {
  // Recall W2 fence-echo fix: the contract example a model echoes inside a ```json fence is
  // a QUOTATION — never a state commit, never scrubbed from an answer.
  const echo = [
    "Here is the notation I need to follow:",
    "```json",
    '{"state_patch": {"verifiedFacts[+]": "example echo — not a commit"}}',
    "```",
    "Proceeding with the actual work now.",
  ].join("\n");
  check("json-fenced echo is not harvested", findStatePatches(echo).length === 0);
  check("json-fenced echo survives answer scrubbing", stripStateFences(echo).includes("example echo"));

  // A genuinely mangled payload OUTSIDE any fence is still recovered (soak behavior kept).
  const mangled = 'report.state {"state_patch": {"verifiedFacts[+]": "real mangled commit"}}';
  check("fence-free mangled payload still harvested", findStatePatches(mangled).length === 1);

  // Contract alignment: >5 keys is rejected with explicit feedback.
  const sixKeys = applyPatch(
    {
      task: "t", findings: [], verifiedFacts: [], testedApproaches: {}, artifacts: {},
      openQuestions: [], nextStep: "", updatedAt: 0,
    },
    {
      state_patch: {
        "findings[+]": "a", "verifiedFacts[+]": "b", "openQuestions[+]": "c",
        "nextStep": "d", "task": "e", "artifacts.k": "f",
      },
    },
    1,
  );
  check("six-key patch rejected whole", !sixKeys.ok && sixKeys.error.kind === "schema");

  // Contract alignment: oversized values are CLAMPED to the promised 120 chars, not accepted
  // whole (old behavior) — Σ stays pointer-shaped.
  const long = "z".repeat(400);
  const clamped = applyPatch(
    {
      task: "t", findings: [], verifiedFacts: [], testedApproaches: {}, artifacts: {},
      openQuestions: [], nextStep: "", updatedAt: 0,
    },
    { state_patch: { "verifiedFacts[+]": long } },
    1,
  );
  check("oversized string value clamped to 120", clamped.ok && clamped.value.verifiedFacts[0]?.length === 120);
}

function digestRecall(): void {
  // Recall W4: NEXT_STEP_RE is word-anchored — "annex"/"willpower" no longer masquerade
  // as next steps.
  check("next-step probe ignores substrings", !NEXT_STEP_RE.test("we annex the findings") && !NEXT_STEP_RE.test("willpower carried the run"));
  check("next-step probe still matches real steps", NEXT_STEP_RE.test("next: wire the archive flush"));

  // Recall W4: digest findings dedup — two near-identical assistant blobs render once.
  const blob = "The retry ladder lives in util/retry.ts and backs off 500ms to 15s across 15 attempts.";
  const args = {
    preparation: {
      firstKeptEntryId: "cut-here",
      messagesToSummarize: [
        { role: "user", content: "study the retry ladder" },
        { role: "assistant", content: `${blob} Also the throttle doubles per strike.` },
        { role: "assistant", content: blob },
      ] as readonly unknown[],
      isSplitTurn: false,
      tokensBefore: 100,
    },
    branchEntries: [],
    config: { rootDigestKeepRecentChars: 200, rootDigestMaxChars: 4_000, skillStateMinScore: 2.5 },
    store: undefined,
  };
  const result = buildRootDigestCompaction(args);
  const findingCount = (result?.compaction.summary.match(/- The retry ladder/g) ?? []).length;
  check("digest findings dedup near-identical prose", findingCount === 1, result?.compaction.summary.slice(0, 200));
}

async function main(): Promise<void> {
  unit();
  await endToEnd();
  fencesAndContract();
  digestRecall();
  finish();
}

runSuite(main);
