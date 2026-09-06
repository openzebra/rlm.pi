/**
 * SKILL.state Workstream B — SkillStore: fail-soft load/save, dedup via claim keys,
 * hits-pinned LRU eviction, flush/reload persistence, BM25 recall paths.
 * Run: bun run pi-plugin/rlm/test/phase-ss-store.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_SKILL_STATE,
  isSkillStateFile,
  loadSkillState,
  saveSkillState,
  SkillStore,
  skillStatePath,
} from "../src/config/skillstate.ts";
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
  const block = reloaded.blockFor("where is settingsPath defined?", 200);
  check("blockFor composes the Ξ header", block.startsWith("[Project facts — SkillState"));
  check("blockFor carries the matching note", block.includes("settingsPath"));
  check("blockFor mentions skill_search", block.includes("skill_search"));
  check("blockFor respects the budget", block.length <= 200 * 4 + 400); // body + header/footer slack
  check("irrelevant query → empty block", reloaded.blockFor("qqzzqxx wwwwxxxzz yyzzzqq", 200) === "");

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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

finish();
