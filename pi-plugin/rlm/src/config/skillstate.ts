/**
 * Workstream B — SkillState: the persistent cross-session distilled-knowledge store.
 *
 * One file per agent (`rlm-skillstate.json`), one section per project (cwd fingerprint). Notes
 * are A-Mem-shaped (minus embeddings — BM25 lexical scoring only): write-time keywords/tags/
 * contextual description, reinforcement by re-encounter (`hits`), LRU eviction with the
 * top-hits quartile pinned.
 *
 * Persistence mirrors `config/settings.ts` exactly — the documented template, not copied
 * logic: fail-soft reader narrowing `JSON.parse(…) as unknown` through a type guard, fail-soft
 * boolean writer (`mkdir` → `writeFile` → `true | false`), frozen empty value on miss/corrupt.
 * The three-state pin semantics of settings (`undefined` = merge-from-disk, `null` = explicit
 * clear) do not apply here: the session-scoped SkillStore is the single writer — it hydrates
 * the whole file, mutates its own project section, and flushes the whole file back, so other
 * projects' sections ride along untouched.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { bm25Rank } from "../util/bm25.ts";
import { deepMergeWithNullDeletion } from "../util/state-merge.ts";
import { formatError } from "../util/errors.ts";
import { isRecord } from "../util/type-guards.ts";
import type { ApproachOutcome, RunState } from "../core/run-state.ts";
import type { RlmConfig } from "../core/types.ts";
import { skillStateLines } from "../prompts/glossary.ts";

/** The outcome detail text per union member (filter can't narrow; this keeps it one switch). */
function outcomeDetail(outcome: ApproachOutcome): string {
  return outcome.status === "failed" ? outcome.reason : outcome.status === "partial" ? outcome.note : outcome.evidence;
}

export const SKILL_STATE_FILE = "rlm-skillstate.json";

/** A-Mem-derived note (no embedding): write-time annotation + reinforcement counter. */
export interface SkillNote {
  /** Claim key — hash(project + normalized text); ledger-style dedup id. */
  readonly id: string;
  /** ≤240 chars, factual, path-anchored. */
  readonly text: string;
  /** A-Mem K_i. */
  readonly keywords: readonly string[];
  /** A-Mem G_i — "config" | "gotcha" | "symbol" | "recipe". */
  readonly tags: readonly string[];
  /** A-Mem X_i — why it matters (≤120 chars). */
  readonly context: string;
  /** Reinforcement count: a duplicate write bumps this instead of duplicating. */
  readonly hits: number;
  readonly ts: number;
  /** A-Mem links — note ids of BM25-nearest neighbors at merge time (bidirectional, ≤LINK_MAX). */
  readonly links?: readonly string[];
  /** Recursion depth of the run that harvested this note (0 = root; child notes crowd less). */
  readonly depth?: number;
}

export interface SkillStateFile {
  readonly version: 1;
  /** key: cwd fingerprint (projectFingerprint of the absolute cwd). */
  readonly projects: Readonly<Record<string, readonly SkillNote[]>>;
}

export const EMPTY_SKILL_STATE: SkillStateFile = Object.freeze({
  version: 1,
  projects: Object.freeze({}),
});

const TAGS: ReadonlySet<string> = new Set(["config", "gotcha", "symbol", "recipe"]);
const NOTE_MAX_CHARS = 240;
const CONTEXT_MAX_CHARS = 120;
const KEYWORDS_MAX = 6;

/**
 * A-Mem link/retrieval constants (frozen; cited by tests). Link generation at merge time is
 * A-Mem §3.2 with BM25 in place of embeddings; retrieval expansion (§Fig. 2 "box") pulls a
 * hit's linked notes back at a discounted score. The floor ramp fixes the cold-start no-op:
 * absolute BM25 floors barely clear on a young store, so they halve below COLD_STORE_NOTES,
 * and the relative factor trims the long tail against the corpus-independent top score.
 */
export const LINK_TOP_K = 3;
export const LINK_MAX = 4;
export const LINK_REL_FLOOR = 0.3;
export const LINK_EXPANSION_FACTOR = 0.6;
export const REL_FLOOR_FACTOR = 0.25;
export const COLD_STORE_NOTES = 8;
export const GOTCHA_NOTES_MAX = 6;

export function skillStatePath(dir?: string): string {
  return join(dir ?? getAgentDir(), SKILL_STATE_FILE);
}

/** Deterministic project key — stable across sessions on the same machine. */
export function projectFingerprint(cwd: string): string {
  return fnv1aHex(resolve(cwd), 0x811c9dc5).slice(0, 12);
}

/**
 * Root Σ WS-1: the BM25 query for a root Ξ composition — the LIVE user prompt wins so
 * mid-session harvested notes rank against what the user is actually asking; the static
 * system-prompt slice is only the empty-prompt fallback (prior behavior).
 */
export function xiQuery(prompt: string, fallback: string): string {
  const trimmed = prompt.trim();
  return trimmed !== "" ? trimmed : fallback;
}

/** FNV-1a hex; two passes for long ids. Never cryptographic — dedup keys only. */
function fnv1aHex(text: string, seed: number): string {
  let hash = seed | 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function noteId(project: string, text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return `${fnv1aHex(`${project}\u0000${normalized}`, 0x811c9dc5)}${fnv1aHex(normalized, 0x01000193)}`;
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return ["symbol"];
  const out: string[] = [];
  for (const tag of tags) {
    if (TAGS.has(tag) && !out.includes(tag)) out.push(tag);
  }
  return out.length > 0 ? out : ["symbol"];
}

export function isSkillNote(value: unknown): value is SkillNote {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.text !== "string" ||
    !isStringArray(value.keywords) ||
    !isStringArray(value.tags) ||
    typeof value.context !== "string" ||
    typeof value.hits !== "number" ||
    typeof value.ts !== "number"
  ) {
    return false;
  }
  // Optional A-Mem fields: absent on pre-link notes (fail-soft read — old files stay valid).
  if (value.links !== undefined && !isStringArray(value.links)) return false;
  if (value.depth !== undefined && typeof value.depth !== "number") return false;
  return true;
}

export function isSkillStateFile(value: unknown): value is SkillStateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.projects)) return false;
  for (const notes of Object.values(value.projects)) {
    if (!Array.isArray(notes)) return false;
    // Corrupt notes are dropped, not fatal (fail-soft read discipline).
    if (!notes.every((n) => isSkillNote(n))) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Fail-soft reader — mirrors settings.ts:loadSettings. Corrupt/missing ⇒ frozen empty. */
export async function loadSkillState(dir?: string): Promise<SkillStateFile> {
  try {
    const raw = JSON.parse(await readFile(skillStatePath(dir), "utf8")) as unknown;
    if (isSkillStateFile(raw)) return raw;
    return EMPTY_SKILL_STATE;
  } catch {
    return EMPTY_SKILL_STATE;
  }
}

/** Fail-soft boolean writer — mirrors settings.ts:saveSettings. */
export async function saveSkillState(s: SkillStateFile, dir?: string): Promise<boolean> {
  try {
    const p = skillStatePath(dir);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// ── Distillation: Σ → notes (the construction half of the one interface) ────────────────

/** Input note shape accepted by SkillStore.merge — ids are computed, never supplied. */
export interface SkillNoteInput {
  readonly text: string;
  readonly keywords?: readonly string[];
  readonly tags?: readonly string[];
  readonly context?: string;
  /** Recursion depth of the harvesting run (0 = root). Recorded, not yet eviction-weighted. */
  readonly depth?: number;
}

const PATH_TOKEN = /(?:[\w@.-]+\/)+[\w@.-]+/g;
const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])/;

/** Deterministic keywords: path tokens + camelCase parts + long words, deduped, ≤6. */
function keywordsOf(text: string): readonly string[] {
  const out: string[] = [];
  const push = (word: string): void => {
    const w = word.trim();
    if (w.length >= 3 && !out.includes(w) && out.length < KEYWORDS_MAX) out.push(w);
  };
  for (const match of text.matchAll(PATH_TOKEN)) push(match[0]);
  for (const raw of text.split(/[^0-9A-Za-z]+/)) {
    if (raw.length > 3) {
      const parts = raw.split(CAMEL_SPLIT);
      if (parts.length > 1) for (const part of parts) push(part.toLowerCase());
    }
  }
  return out;
}

/**
 * Workstream B Hook 1 (deterministic half): harvest Σ into note inputs — zero extra tokens.
 * verifiedFacts → "symbol" notes; successful approaches → "recipe" notes; the most recent
 * failed approaches → "gotcha" notes (the reusable don't-do-this-again material, capped so a
 * failure-heavy run cannot flood the store).
 */
export function notesFromRunState(state: RunState, depth = 0): readonly SkillNoteInput[] {
  const notes: SkillNoteInput[] = [];
  for (const fact of state.verifiedFacts) {
    if (fact.trim().length < 8) continue;
    notes.push({
      text: fact.trim().slice(0, NOTE_MAX_CHARS),
      keywords: keywordsOf(fact),
      tags: ["symbol"],
      context: state.task.slice(0, CONTEXT_MAX_CHARS),
      depth,
    });
  }
  for (const [key, outcome] of Object.entries(state.testedApproaches)) {
    if (outcome.status !== "succeeded") continue;
    const text = `${key}: ${outcome.evidence}`.slice(0, NOTE_MAX_CHARS);
    notes.push({
      text,
      keywords: keywordsOf(text),
      tags: ["recipe"],
      context: state.task.slice(0, CONTEXT_MAX_CHARS),
      depth,
    });
  }
  const failed = Object.entries(state.testedApproaches)
    .filter(([, outcome]) => outcome.status !== "succeeded")
    .slice(-GOTCHA_NOTES_MAX);
  for (const [key, outcome] of failed) {
    const text = `${key} — ${outcomeDetail(outcome)}`.slice(0, NOTE_MAX_CHARS);
    notes.push({
      text,
      keywords: keywordsOf(text),
      tags: ["gotcha"],
      context: state.task.slice(0, CONTEXT_MAX_CHARS),
      depth,
    });
  }
  return notes;
}

/**
 * A-Mem phrasing prompt (Hook 1, LLM half — enableSkillStateDistill, default ON). Failed and
 * partial approaches ride along: they are usually the most reusable gotcha/recipe material,
 * and feeding only verifiedFacts starved the store of exactly that.
 */
export function distillPromptFor(state: RunState): string {
  const approaches = Object.entries(state.testedApproaches)
    .filter(([, outcome]) => outcome.status !== "succeeded")
    .slice(-8)
    .map(([key, outcome]) =>
      `- ${key} — ${outcomeDetail(outcome)} (${outcome.status})`);
  const lines = [
    "Distill AT MOST 6 durable, reusable project facts from this run. One per line, exactly:",
    "text | kw1, kw2 | tag",
    'tag ∈ {config, gotcha, symbol, recipe}. text ≤240 chars, factual, path-anchored. No preamble.',
    "",
    `Run task: ${state.task}`,
    "Verified facts:",
    ...state.verifiedFacts.slice(-12).map((f) => `- ${f}`),
  ];
  if (approaches.length > 0) {
    lines.push("Failed or partial approaches (gotcha candidates — what NOT to retry):", ...approaches);
  }
  if (state.nextStep.trim() !== "") {
    lines.push(`Next step at run end: ${state.nextStep}`);
  }
  return lines.join("\n");
}

/**
 * Defensive parser for the distill leaf's output — anything malformed is dropped. `context`
 * (the run task) is supplied by the caller so distilled notes carry a non-empty A-Mem X_i;
 * an empty context weakened BM25 ranking for every LLM-distilled note.
 */
export function parseDistilledNotes(raw: string, context = ""): readonly SkillNoteInput[] {
  const out: SkillNoteInput[] = [];
  const contextSlice = context.slice(0, CONTEXT_MAX_CHARS);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim().replace(/^-\s*/, "");
    if (trimmed === "") continue;
    const parts = trimmed.split("|");
    if (parts.length < 2) continue;
    const text = parts[0].trim();
    if (text.length < 8) continue;
    const keywords = (parts[1] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length >= 3)
      .slice(0, KEYWORDS_MAX);
    const tags = (parts[2] ?? "")
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => TAGS.has(t));
    out.push({
      text: text.slice(0, NOTE_MAX_CHARS),
      keywords,
      tags: normalizeTags(tags),
      context: contextSlice,
    });
    if (out.length >= 6) break;
  }
  return out;
}

// ── Read path: BM25 selection for Ξ, leaf grounding, and skill_search ───────────────────

function noteCorpus(note: SkillNote): string {
  return `${note.text} ${note.keywords.join(" ")} ${note.tags.join(" ")} ${note.context}`;
}

/**
 * A-Mem §3.2/§3.3, deterministic (no embeddings, no LLM): each NEW note links its
 * BM25-nearest neighbors above a relative floor (bidirectional, LINK_MAX cap), and each
 * formed link co-reinforces the neighbor (hits bump + ts touch — the store-side analog of
 * A-Mem memory evolution). Pure over its inputs; `now` is the merge timestamp.
 */
function linkNewNotes(
  notes: readonly SkillNote[],
  newIds: ReadonlySet<string>,
  now: number,
): readonly SkillNote[] {
  if (newIds.size === 0 || notes.length < 2) return notes;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const updated = new Map<string, SkillNote>();
  const current = (id: string): SkillNote | undefined => updated.get(id) ?? byId.get(id);
  for (const id of newIds) {
    const note = current(id);
    if (note === undefined) continue;
    const candidates = notes.filter((other) => other.id !== id);
    const ranked = bm25Rank(
      noteCorpus(note),
      candidates.map((other) => ({ item: other, text: noteCorpus(other) })),
      LINK_TOP_K,
    );
    if (ranked.length === 0) continue;
    const top = ranked[0].score;
    const links = [...(note.links ?? [])];
    for (const { item, score } of ranked) {
      if (links.length >= LINK_MAX) break;
      if (score <= 0 || score < LINK_REL_FLOOR * top) continue;
      if (links.includes(item.id)) continue;
      links.push(item.id);
      const neighbor = current(item.id);
      if (neighbor === undefined) continue;
      const neighborLinks = [...(neighbor.links ?? [])];
      if (!neighborLinks.includes(id) && neighborLinks.length < LINK_MAX) {
        neighborLinks.push(id);
      }
      // Co-reinforcement: the neighbor was just confirmed related — evolution, not rewrite.
      updated.set(neighbor.id, { ...neighbor, links: neighborLinks, hits: neighbor.hits + 1, ts: now });
    }
    updated.set(id, { ...note, links });
  }
  if (updated.size === 0) return notes;
  return notes.map((note) => updated.get(note.id) ?? note);
}

export interface SkillSearchHit {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly score: number;
}

/**
 * The session-scoped store — hydrated once at session_start, flushed at session_shutdown.
 * All recall (Ξ block, leaf grounding, skill_search) reads through the same BM25 rank.
 */
export class SkillStore {
  private constructor(
    private file: SkillStateFile,
    private readonly project: string,
    private readonly notesPerProject: number,
    private readonly dir: string | undefined,
    private dirty = false,
  ) {}

  static async hydrate(notesPerProject: number, dir?: string): Promise<SkillStore> {
    return new SkillStore(
      await loadSkillState(dir),
      projectFingerprint(process.cwd()),
      Math.max(1, Math.floor(notesPerProject)),
      dir,
    );
  }

  get projectKey(): string {
    return this.project;
  }

  get noteCount(): number {
    return this.file.projects[this.project]?.length ?? 0;
  }

  /** Tag histogram over this project's notes — ONE summary source (distill card, telemetry). */
  stats(): { readonly notes: number; readonly byTag: Readonly<Record<string, number>> } {
    const notes = this.file.projects[this.project] ?? [];
    const byTag: Record<string, number> = {};
    for (const note of notes) {
      for (const tag of note.tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
    return { notes: notes.length, byTag };
  }

  /** Test/telemetry seam — the exact on-disk shape a flush would write. */
  snapshot(): SkillStateFile {
    return this.file;
  }

  /**
   * BM25 rank + A-Mem "box" expansion (§Fig. 2): a hit's linked notes ride along at
   * LINK_EXPANSION_FACTOR × the hit's score, deduped — base hits always outrank expansions.
   * Sorted desc; callers slice. The one recall rank for search/pack (DRY).
   */
  private rankWithLinks(
    query: string,
    k: number,
  ): readonly { readonly note: SkillNote; readonly score: number }[] {
    const notes = this.file.projects[this.project] ?? [];
    if (notes.length === 0 || query.trim() === "") return [];
    const byId = new Map(notes.map((note) => [note.id, note]));
    const ranked = bm25Rank(
      query,
      notes.map((note) => ({ item: note, text: noteCorpus(note) })),
      Math.max(1, k),
    );
    const merged = new Map<string, { note: SkillNote; score: number }>();
    for (const { item, score } of ranked) {
      merged.set(item.id, { note: item, score });
      for (const link of item.links ?? []) {
        if (merged.has(link)) continue;
        const neighbor = byId.get(link);
        if (neighbor !== undefined) {
          merged.set(link, { note: neighbor, score: score * LINK_EXPANSION_FACTOR });
        }
      }
    }
    const out = [...merged.values()];
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * Effective acceptance floor: the configured absolute floor (halved on a cold store —
   * absolute BM25 floors barely clear when the corpus is small, so grounding silently no-ops
   * exactly when the store is young) lifted by the relative long-tail cut (REL_FLOOR_FACTOR ×
   * top score). `minScore <= 0` keeps the old inject-anything behavior unchanged.
   */
  private effectiveFloor(ranked: readonly { readonly score: number }[], minScore: number): number {
    if (minScore <= 0) return 0;
    const ramped = this.noteCount < COLD_STORE_NOTES ? minScore * 0.5 : minScore;
    const top = ranked[0]?.score ?? 0;
    return Math.max(ramped, top * REL_FLOOR_FACTOR);
  }

  /** Workstream E: the sandbox skill_search surface. Score > 0 hits only, best first. */
  search(query: string, k = 8): readonly SkillSearchHit[] {
    const cap = Math.max(1, Math.min(32, k));
    const ranked = this.rankWithLinks(query, cap);
    return ranked
      .slice(0, cap + LINK_TOP_K) // base hits + their expansions, bounded
      .map(({ note, score }) => ({
        id: note.id,
        text: note.text,
        tags: note.tags,
        score: Math.round(score * 100) / 100,
      }));
  }

  /** Ξ body lines shared by blockFor/sliceForPrompt — packed greedily under the char budget. */
  private pack(
    query: string,
    k: number,
    budgetChars: number,
    minScore: number,
  ): readonly string[] {
    const ranked = this.rankWithLinks(query, k);
    if (ranked.length === 0) return [];
    const floor = this.effectiveFloor(ranked, minScore);
    const lines: string[] = [];
    let used = 0;
    for (const { note, score } of ranked) {
      if (score < floor) break; // ranked desc — the first miss ends the window
      const line = `- (${note.tags[0] ?? "symbol"}) ${note.text}`;
      if (used + line.length + 1 > budgetChars) continue; // too fat — try the next, smaller
      lines.push(line);
      used += line.length + 1;
    }
    return lines;
  }

  /**
   * Workstream C: the full Ξ block for a root prompt (header via skillStateLines — the single
   * wording source). "" when nothing is relevant or the store is empty. Recall W3: `minScore`
   * gates the block (was `Number.MIN_VALUE` — stale cross-session notes rode every prompt);
   * 0 keeps the old inject-anything behavior.
   */
  blockFor(query: string, budgetTokens: number, minScore: number): string {
    const lines = this.pack(query, 24, Math.max(0, budgetTokens) * 4, minScore);
    if (lines.length === 0) return "";
    return skillStateLines(lines.length, lines.join("\n"));
  }

  /**
   * Workstream D: grounded leaf lines. "" unless the top BM25 score clears `minScore`
   * (below-threshold prompts stay byte-identical — grounding must never add noise).
   */
  sliceForPrompt(query: string, budgetTokens: number, minScore: number): string {
    const lines = this.pack(query, 8, Math.max(0, budgetTokens) * 4, minScore);
    return lines.join("\n");
  }

  /**
   * Dedup write: duplicate (by normalized text) bumps `hits` and refreshes `ts`; new notes
   * insert. Per-project cap with LRU-by-ts eviction, top-hits quartile pinned. New notes then
   * get A-Mem §3.2 link generation (BM25-nearest neighbors, bidirectional) with §3.3-style
   * deterministic evolution: linked neighbors co-reinforce (hits bump + ts touch).
   */
  merge(inputs: readonly SkillNoteInput[]): void {
    if (inputs.length === 0) return;
    const existing = this.file.projects[this.project] ?? [];
    const byId = new Map<string, SkillNote>(existing.map((note) => [note.id, note]));
    const now = Date.now();
    const newIds = new Set<string>();
    for (const input of inputs) {
      const text = input.text.trim();
      if (text === "") continue;
      const id = noteId(this.project, text);
      const prev = byId.get(id);
      if (prev !== undefined) {
        // Reinforcement, not duplication. The one merge (state-merge.ts) composes the update;
        // the result is re-narrowed — a malformed merge outcome keeps the previous note.
        const mergedKeywords = [...prev.keywords];
        for (const keyword of input.keywords ?? []) {
          if (!mergedKeywords.includes(keyword) && mergedKeywords.length < KEYWORDS_MAX) {
            mergedKeywords.push(keyword);
          }
        }
        const merged = deepMergeWithNullDeletion(prev, {
          hits: prev.hits + 1,
          ts: now,
          keywords: mergedKeywords,
        });
        byId.set(id, isSkillNote(merged) ? merged : prev);
      } else {
        const note: SkillNote = {
          id,
          text: text.slice(0, NOTE_MAX_CHARS),
          keywords: (input.keywords ?? []).slice(0, KEYWORDS_MAX),
          tags: normalizeTags(input.tags),
          context: (input.context ?? "").slice(0, CONTEXT_MAX_CHARS),
          hits: 1,
          ts: now,
          ...(input.depth === undefined ? {} : { depth: input.depth }),
        };
        byId.set(id, note);
        newIds.add(id);
      }
    }
    let notes: readonly SkillNote[] = [...byId.values()];
    if (notes.length > this.notesPerProject) {
      // Pinned: top quartile by hits (ceil) — frequently-reinforced facts survive eviction.
      const byHits = [...notes].sort((a, b) => b.hits - a.hits || b.ts - a.ts);
      const pinned = new Set(
        byHits.slice(0, Math.max(1, Math.ceil(byHits.length / 4))).map((note) => note.id),
      );
      const evictable = notes
        .filter((note) => !pinned.has(note.id))
        .sort((a, b) => a.ts - b.ts);
      const evict = new Set(evictable.slice(0, notes.length - this.notesPerProject).map((note) => note.id));
      notes = notes.filter((note) => !evict.has(note.id));
    }
    notes = linkNewNotes(notes, newIds, now);
    this.file = { version: 1, projects: { ...this.file.projects, [this.project]: notes } };
    this.dirty = true;
  }

  /** Flush to disk (fail-soft). Other projects' sections ride along from the hydrated file. */
  async flush(): Promise<boolean> {
    if (!this.dirty) return true;
    const written = await saveSkillState(this.file, this.dir);
    if (written) this.dirty = false;
    return written;
  }
}

// ── Wiring helpers (one implementation each — both composition roots reuse these) ────────

/**
 * Workstream D leaf grounding — THE implementation complete1 delegates to via
 * `SubcallHandlerDeps.groundLeaf`. Below-threshold ⇒ byte-identical prompt.
 */
export function groundLeafPrompt(
  store: SkillStore,
  config: Pick<RlmConfig, "skillStateLeafTokens" | "skillStateMinScore">,
  prompt: string,
): string {
  const slice = store.sliceForPrompt(prompt, config.skillStateLeafTokens, config.skillStateMinScore);
  return slice === "" ? prompt : `[Project facts]\n${slice}\n\n${prompt}`;
}

/**
 * Workstream E host handler — the ONE skill_search implementation, served to both sandboxes
 * (engine + repl tool). Unwired/disabled stores reply with an error string, never a throw.
 */
export function skillSearchHandler(
  getStore: () => SkillStore | undefined,
): (query: string, k: number, depth: number) => Promise<string> {
  return async (query, k) => {
    const store = getStore();
    if (store === undefined) return formatError("skill state store not configured");
    try {
      return JSON.stringify(store.search(query, k));
    } catch (err: unknown) {
      return formatError(err instanceof Error ? err.message : String(err));
    }
  };
}

/** The config slice groundLeafPrompt needs — callers pass their live RlmConfig. */
export type GroundLeafConfig = Pick<RlmConfig, "skillStateLeafTokens" | "skillStateMinScore">;
