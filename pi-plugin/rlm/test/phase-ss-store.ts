/**
 * SKILL.state Workstream B — SkillStore: fail-soft load/save, dedup via claim keys,
 * hits-pinned LRU eviction, flush/reload persistence, BM25 recall paths.
 * Run: bun run pi-plugin/rlm/test/phase-ss-store.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  distillPromptFor,
  EMPTY_SKILL_STATE,
  isSkillStateFile,
  loadSkillState,
  notesFromRunState,
  parseDistilledNotes,
  saveSkillState,
  SkillStore,
  skillStatePath,
} from "../src/config/skillstate.ts";
import type { RunState } from "../src/core/run-state.ts";
import { check, finish } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "rlm-skillstate-test-"));
const FILE = join(tmp, "rlm-skillstate.json");

try {
  // ── fail-soft reads ──
  check("missing file → frozen empty", (await loadSkillState(tmp)) === EMPTY_SKILL_STATE);
  writeFileSync(FILE, "{corrupt json", "utf8");
  check("corrupt file → frozen empty", (await loadSkillState(tmp)) === EMPTY_SKILL_STATE);
  writeFileSync(FILE, JSON.stringify({ version: 1, projects: { x: [{ nope: true }] } }), "utf8");
  check("malformed notes → frozen empty", (await loadSkillState(tmp)) === EMPTY_SKILL_STATE);
  check("guard accepts the real shape", isSkillStateFile({ version: 1, projects: {} }));

  // ── hydrate + merge + dedup ──
  const store = await SkillStore.hydrate(3, tmp); // cap 3 → eviction is exercisable
  check("fresh store is empty", store.noteCount === 0);
  store.merge([
    { text: "config/settings.ts:22 — settingsPath() joins getAgentDir()", keywords: ["settingspath"], tags: ["config"] },
    { text: "llm_query has NO filesystem — never 'Read path/to/file.ts'", tags: ["gotcha"] },
  ]);
  check("two notes stored", store.noteCount === 2);
  const firstId = store.snapshot().projects[store.projectKey]?.[0]?.id ?? "";
  check("note ids are stable hashes", firstId.length >= 12);

  store.merge([{ text: "config/settings.ts:22 — settingsPath() joins getAgentDir()", tags: ["config"] }]);
  check("duplicate bumps hits, not count", store.noteCount === 2);
  check("reinforcement counted", store.snapshot().projects[store.projectKey]?.some((n) => n.hits === 2) ?? false);

  // ── eviction: cap 3, reinforced note pinned ──
  store.merge([
    { text: "third note about worker model ranking in this project", tags: ["recipe"] },
    { text: "fourth note about the sandbox RESERVED frozenset here", tags: ["symbol"] },
    { text: "fifth note — unrelated filler fact for eviction pressure", tags: ["symbol"] },
  ]);
  check("cap enforced", store.noteCount === 3, String(store.noteCount));
  const survived = store.snapshot().projects[store.projectKey] ?? [];
  check(
    "hits-pinned note survived eviction",
    survived.some((n) => n.hits === 2),
  );
  check(
    "newest notes survived",
    survived.some((n) => n.text.startsWith("fifth note")),
  );

  // ── flush + reload (cross-"session" persistence) ──
  check("flush writes", await store.flush());
  check("flush is idempotent when clean", await store.flush());
  const reloaded = await SkillStore.hydrate(3, tmp);
  check("reload sees the same notes", reloaded.noteCount === 3);
  check("project key stable across stores", reloaded.projectKey === store.projectKey);

  // ── BM25 recall paths ──
  const block = reloaded.blockFor("where is settingsPath defined?", 200, 0);
  check("blockFor composes the Ξ header", block.startsWith("[Project facts — SkillState"));
  check("blockFor carries the matching note", block.includes("settingsPath"));
  check("blockFor mentions skill_search", block.includes("skill_search"));
  check("blockFor respects the budget", block.length <= 200 * 4 + 400); // body + header/footer slack
  check("irrelevant query → empty block", reloaded.blockFor("qqzzqxx wwwwxxxzz yyzzzqq", 200, 0) === "");

  const grounded = reloaded.sliceForPrompt("settingsPath definition location", 200, 1.0);
  check("sliceForPrompt attaches above threshold", grounded.includes("settingsPath"));
  check("sliceForPrompt below threshold → byte-identical", reloaded.sliceForPrompt("qqzzqxx wwwwxxxzz yyzzzqq", 200, 1.0) === "");
  check("huge minScore → never grounds", reloaded.sliceForPrompt("settingsPath", 200, 1e9) === "");

  const hits = reloaded.search("settingsPath getAgentDir", 5);
  check("search returns ranked hits", hits.length >= 1 && hits[0].text.includes("settingsPath"));
  check("search scores positive", (hits[0].score ?? 0) > 0);
  check("search on empty query → []", reloaded.search("", 5).length === 0);

  // ── direct save/load round-trip ──
  const snap = reloaded.snapshot();
  check("saveSkillState writes", await saveSkillState(snap, tmp));
  check("loadSkillState reads back", (await loadSkillState(tmp)).projects[reloaded.projectKey]?.length === 3);
  check("path helper nests the file name", skillStatePath(tmp).endsWith("rlm-skillstate.json"));

  // ── A-Mem link generation + co-reinforcement ──
  const linked = await SkillStore.hydrate(16, tmp);
  linked.merge([
    { text: "config/rlm.json enableLedger toggles the task ledger blackboard", tags: ["config"] },
  ]);
  linked.merge([
    { text: "config/rlm.json enableLedger gates the ledger blackboard per run", tags: ["config"] },
    // Vocabulary disjoint from everything else in the store (this tmp store still holds
    // leftover notes from the round-trip above) — only a true lexical miss proves the floor.
    { text: "xxqwqq zzzvvq wubbfleddun flurboscopy blintzathon zzqvvr", tags: ["symbol"] },
  ]);
  const linkedNotes = linked.snapshot().projects[linked.projectKey] ?? [];
  const ledgerNotes = linkedNotes.filter((n) => n.text.includes("enableLedger"));
  check("related notes link bidirectionally",
    ledgerNotes.length === 2
    && ledgerNotes[0].links?.includes(ledgerNotes[1].id) === true
    && ledgerNotes[1].links?.includes(ledgerNotes[0].id) === true,
    JSON.stringify(ledgerNotes.map((n) => n.links)));
  const nonsense = linkedNotes.find((n) => n.text.includes("wubbfleddun"));
  // The nonsense note may still link via its shared "symbol" TAG (tags are corpus — correct
  // A-Mem behavior), but never to the lexically unrelated ledger cluster.
  const ledgerIds = new Set(ledgerNotes.map((n) => n.id));
  check("lexically disjoint note never links the unrelated cluster",
    nonsense !== undefined && (nonsense.links ?? []).every((id) => !ledgerIds.has(id))
    && ledgerNotes.every((n) => (n.links ?? []).every((id) => id !== nonsense?.id)),
    JSON.stringify({ nonsense: nonsense?.links, ledgers: ledgerNotes.map((n) => n.links) }));
  const ledgerFirst = ledgerNotes.find((n) => n.hits === 2);
  check("link formation co-reinforces the neighbor (A-Mem evolution)", ledgerFirst !== undefined);

  // ── retrieval expansion: a hit pulls its linked notes back at a discount ──
  const expansionHits = linked.search("enableLedger blackboard gating", 5);
  check("search returns both linked ledger notes",
    expansionHits.filter((h) => h.text.includes("enableLedger")).length === 2,
    JSON.stringify(expansionHits.map((h) => [h.text.slice(0, 30), h.score])));
  check("expansion hits rank below their base hit",
    expansionHits.length >= 2 && expansionHits[0].score >= expansionHits[1].score);

  // ── cold-start ramp: absolute floors halve on a young store ──
  const cold = await SkillStore.hydrate(16, tmp);
  cold.merge([{ text: "sandbox/py/worker.py parks sub-LLM replies by rid for await_task", tags: ["symbol"] }]);
  const coldScore = cold.search("await_task rid reply parking worker", 1)[0]?.score ?? 0;
  check("cold score is exercisable", coldScore > 1, String(coldScore));
  const ambitious = Math.ceil(coldScore * 1.5 * 100) / 100; // above the raw score, below 2×
  check("cold store halves the floor (weak-but-real match grounds)",
    cold.sliceForPrompt("await_task rid reply parking worker", 200, ambitious) !== "");
  const warm = await SkillStore.hydrate(64, tmp);
  warm.merge([{ text: "sandbox/py/worker.py parks sub-LLM replies by rid for await_task", tags: ["symbol"] }]);
  for (let i = 0; i < 10; i++) {
    warm.merge([{ text: `filler note ${i} about unrelated plumbing detail number ${i}${i}`, tags: ["symbol"] }]);
  }
  // The warm store scores the same query HIGHER (idf grows with N), so the threshold must be
  // computed against the warm score itself: 1.5× top clears the full floor, fails the ramp.
  const warmScore = warm.search("await_task rid reply parking worker", 1)[0]?.score ?? 0;
  const warmAmbitious = Math.ceil(warmScore * 1.5 * 100) / 100;
  check("warm store keeps the full floor (same query, 1.5× warm score → no grounding)",
    warm.sliceForPrompt("await_task rid reply parking worker", 200, warmAmbitious) === "");

  // ── distill enrichment ──
  const runState: RunState = {
    task: "wire the archive recall path",
    findings: [],
    verifiedFacts: [],
    testedApproaches: {
      "grep -r elided": { status: "failed", reason: "pattern never matched the stub wording" },
      "read root-context.ts": { status: "partial", note: "found the transform but not the flush" },
    },
    artifacts: {},
    openQuestions: [],
    nextStep: "check index.ts session_start wiring",
    updatedAt: 0,
  };
  const deterministic = notesFromRunState(runState, 2);
  check("failed approach becomes a gotcha note",
    deterministic.some((n) => n.tags?.includes("gotcha") && n.text.includes("never matched")));
  check("partial approach becomes a gotcha note",
    deterministic.some((n) => n.tags?.includes("gotcha") && n.text.includes("found the transform")));
  check("depth is recorded on harvested notes", deterministic.every((n) => n.depth === 2));
  const distillPrompt = distillPromptFor(runState);
  check("distill prompt carries failed/partial approaches",
    distillPrompt.includes("Failed or partial approaches") && distillPrompt.includes("never matched"));
  check("distill prompt carries the next step", distillPrompt.includes("check index.ts session_start wiring"));
  const parsed = parseDistilledNotes(
    "config/rlm.json enableLedger is enforced | enableledger, rlm.json | config\n\ngarbage line\n",
    runState.task,
  );
  check("parseDistilledNotes fills context from the run task",
    parsed.length === 1 && parsed[0].context === "wire the archive recall path");

  // ── pre-link notes (old files) stay valid ──
  writeFileSync(
    FILE,
    JSON.stringify({
      version: 1,
      projects: {
        legacy: [{ id: "aabbccdd11223344", text: "old note without links or depth", keywords: [], tags: ["symbol"], context: "", hits: 1, ts: 1 }],
      },
    }),
    "utf8",
  );
  const legacy = await loadSkillState(tmp);
  check("legacy note (no links/depth) loads", legacy !== EMPTY_SKILL_STATE
    && legacy.projects.legacy?.length === 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

finish();
