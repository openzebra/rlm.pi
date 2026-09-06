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
import type { RunState } from "../core/run-state.ts";
import type { RlmConfig } from "../core/types.ts";
import { skillStateLines } from "../prompts/glossary.ts";

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

export function skillStatePath(dir?: string): string {
  return join(dir ?? getAgentDir(), SKILL_STATE_FILE);
}

/** Deterministic project key — stable across sessions on the same machine. */
export function projectFingerprint(cwd: string): string {
  return fnv1aHex(resolve(cwd), 0x811c9dc5).slice(0, 12);
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
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isStringArray(value.keywords) &&
    isStringArray(value.tags) &&
    typeof value.context === "string" &&
    typeof value.hits === "number" &&
    typeof value.ts === "number"
  );
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
 * verifiedFacts → "symbol" notes; successful approaches → "recipe" notes.
 */
export function notesFromRunState(state: RunState): readonly SkillNoteInput[] {
  const notes: SkillNoteInput[] = [];
  for (const fact of state.verifiedFacts) {
    if (fact.trim().length < 8) continue;
    notes.push({
      text: fact.trim().slice(0, NOTE_MAX_CHARS),
      keywords: keywordsOf(fact),
      tags: ["symbol"],
      context: state.task.slice(0, CONTEXT_MAX_CHARS),
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
    });
  }
  return notes;
}

/** A-Mem phrasing prompt (Hook 1, LLM half — enableSkillStateDistill, default ON). */
export function distillPromptFor(state: RunState): string {
  return [
    "Distill AT MOST 6 durable, reusable project facts from this run. One per line, exactly:",
    "text | kw1, kw2 | tag",
    'tag ∈ {config, gotcha, symbol, recipe}. text ≤240 chars, factual, path-anchored. No preamble.',
    "",
    `Run task: ${state.task}`,
    "Verified facts:",
    ...state.verifiedFacts.slice(-12).map((f) => `- ${f}`),
  ].join("\n");
}

/** Defensive parser for the distill leaf's output — anything malformed is dropped. */
export function parseDistilledNotes(raw: string): readonly SkillNoteInput[] {
  const out: SkillNoteInput[] = [];
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
    out.push({ text: text.slice(0, NOTE_MAX_CHARS), keywords, tags: normalizeTags(tags) });
    if (out.length >= 6) break;
  }
  return out;
}

// ── Read path: BM25 selection for Ξ, leaf grounding, and skill_search ───────────────────

function noteCorpus(note: SkillNote): string {
  return `${note.text} ${note.keywords.join(" ")} ${note.tags.join(" ")} ${note.context}`;
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

  /** Test/telemetry seam — the exact on-disk shape a flush would write. */
  snapshot(): SkillStateFile {
    return this.file;
  }

  /** Workstream E: the sandbox skill_search surface. Score > 0 hits only, best first. */
  search(query: string, k = 8): readonly SkillSearchHit[] {
    const notes = this.file.projects[this.project] ?? [];
    if (notes.length === 0 || query.trim() === "") return [];
    const ranked = bm25Rank(
      query,
      notes.map((note) => ({ item: note, text: noteCorpus(note) })),
      Math.max(1, Math.min(32, k)),
    );
    return ranked.map(({ item, score }) => ({
      id: item.id,
      text: item.text,
      tags: item.tags,
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
    const notes = this.file.projects[this.project] ?? [];
    if (notes.length === 0) return [];
    const ranked = bm25Rank(
      query,
      notes.map((note) => ({ item: note, text: noteCorpus(note) })),
      Math.min(k, notes.length),
    );
    const lines: string[] = [];
    let used = 0;
    for (const { item, score } of ranked) {
      if (score < minScore) break; // ranked desc — the first miss ends the window
      const line = `- (${item.tags[0] ?? "symbol"}) ${item.text}`;
      if (used + line.length + 1 > budgetChars) continue; // too fat — try the next, smaller
      lines.push(line);
      used += line.length + 1;
    }
    return lines;
  }

  /**
   * Workstream C: the full Ξ block for a root prompt (header via skillStateLines — the single
   * wording source). "" when nothing is relevant or the store is empty.
   */
  blockFor(query: string, budgetTokens: number): string {
    const lines = this.pack(query, 24, Math.max(0, budgetTokens) * 4, Number.MIN_VALUE);
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
   * insert. Per-project cap with LRU-by-ts eviction, top-hits quartile pinned.
   */
  merge(inputs: readonly SkillNoteInput[]): void {
    if (inputs.length === 0) return;
    const existing = this.file.projects[this.project] ?? [];
    const byId = new Map<string, SkillNote>(existing.map((note) => [note.id, note]));
    const now = Date.now();
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
        };
        byId.set(id, note);
      }
    }
    let notes = [...byId.values()];
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
