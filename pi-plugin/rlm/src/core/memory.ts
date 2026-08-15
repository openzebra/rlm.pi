/**
 * Durable memory (port of rlm_test v5 `memory/store.py`).
 *
 * L1 episodes: content-addressed replay — a recorded child/root answer replays for ZERO
 * API calls while every file it touched still hashes to the recorded sha256.
 * L2 notes: A-MEM-lite BM25 notes over {content, context, keywords, tags, paths, symbols},
 * batched consolidation (no per-write evolve), link-on-write to top-4 neighbors.
 *
 * Layout (v5-identical): `<root>/.rlm/memory/{episodes.jsonl, notes.json}`.
 * All I/O is fail-soft: writers return booleans and never throw — a corrupt or missing
 * store degrades to a no-op, it never takes a run down.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const TOK = /[a-z0-9]{2,}/g;
const EPISODE_CAP = 4_000;
const INJECT_HEADER = "[memory] retrieved notes (do not restudy these paths unless hashes went stale):";
const NOTE_CONTENT_CHARS = 280;
const LINK_NEIGHBORS = 4;
const KEYWORDS_MAX = 12;

export interface Episode {
  readonly key: string;
  readonly kind: "rlm" | "root";
  readonly model: string;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly pathHashes: Readonly<Record<string, string>>;
  readonly result: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly ts: number;
}

export interface Note {
  readonly id: string;
  readonly content: string;
  readonly timestamp: number;
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  readonly context: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly links: readonly string[];
  readonly sourceKeys: readonly string[];
}

export interface MemoryStats {
  readonly episodes: number;
  readonly notes: number;
  readonly hits: number;
  readonly misses: number;
  readonly notesInjected: number;
}

/** Single completion seam for consolidation (wired to bridge/model at the composition root). */
export type MemoryLlm = (prompt: string) => Promise<string>;

export interface MemoryOptions {
  /** Override directory; default resolves to `<root>/.rlm/memory`. */
  readonly dir?: string;
  readonly injectNoteTokens?: number;
  readonly evolveEvery?: number;
  readonly llm?: MemoryLlm;
}

function tokenize(text: string): readonly string[] {
  return (text.toLowerCase().replace(/_/g, " ").replace(/-/g, " ").match(TOK) ?? []) as readonly string[];
}

function noteBlob(n: Note): string {
  return [n.content, n.context, n.keywords.join(" "), n.tags.join(" "), n.paths.join(" "), n.symbols.join(" ")].join(" ");
}

/** Sync streamed sha256 (64KiB chunks via readSync — audit H7): a huge path must never
 *  buffer whole in memory, and no async contagion into recordEpisode/replay. */
export function fileSha256(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const h = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
    return h.digest("hex");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed — nothing to do
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** H6 (audit): the real-file slice of a root context — cwd-seeded entries (un-prefixed
 *  paths with string content), bounded, `ctx/<id>/…` virtual sources excluded (they have no
 *  disk file to hash). These are what a root episode snapshots for replay invalidation. */
export function rootContextPaths(context: unknown, max: number): readonly string[] {
  if (!Array.isArray(context)) return Object.freeze([]);
  const out: string[] = [];
  for (const item of context) {
    if (out.length >= max) break;
    if (isRecord(item) && typeof item.path === "string" && typeof item.content === "string") {
      const p = item.path;
      if (p !== "" && !p.startsWith("ctx/") && !p.includes("/ctx/") && !p.startsWith("/")) out.push(p);
    }
  }
  return Object.freeze(out);
}

export class MemoryStore {
  readonly enabled: boolean;
  private dir: string | undefined;
  private readonly pinnedDir: boolean;
  private readonly injectNoteTokens: number;
  private readonly evolveEvery: number;
  private llm: MemoryLlm | undefined;
  private root: string;
  private episodes = new Map<string, Episode>();
  private notes = new Map<string, Note>();
  private pending: readonly string[] = [];
  private hits = 0;
  private misses = 0;
  private notesInjected = 0;
  private loaded = false;

  constructor(root: string, opts: MemoryOptions = {}, enabled = true) {
    this.root = root;
    this.enabled = enabled && opts.dir !== null;
    this.pinnedDir = opts.dir !== undefined;
    this.dir = this.enabled ? (opts.dir ?? join(root, ".rlm", "memory")) : undefined;
    this.injectNoteTokens = opts.injectNoteTokens ?? 2_000;
    this.evolveEvery = opts.evolveEvery ?? 8;
    this.llm = opts.llm;
  }

  /** Session hooks: the consolidation model + real workspace root arrive after construction. */
  setLlm(llm: MemoryLlm): void {
    this.llm = llm;
  }

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    if (!this.pinnedDir && this.enabled) this.dir = join(root, ".rlm", "memory");
    this.loaded = false;
    this.episodes = new Map();
    this.notes = new Map();
    this.pending = [];
  }

  // ── L1: episodes ────────────────────────────────────────────────────────────

  /** H7 (audit): resolve a rel-path INSIDE the root only — `../` traversal gets no digest. */
  private safeAbs(rel: string): string | undefined {
    const rootAbs = resolve(this.root);
    const abs = resolve(rootAbs, rel);
    return abs === rootAbs || abs.startsWith(rootAbs + sep) ? abs : undefined;
  }

  /** Record a completed run. Snapshots path hashes; triggers consolidation on threshold. */
  recordEpisode(req: {
    readonly key: string;
    readonly kind: "rlm" | "root";
    readonly model: string;
    readonly prompt: string;
    readonly paths: readonly string[];
    readonly result: string;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  }): boolean {
    if (!this.enabled || this.dir === undefined || req.result === "") return false;
    this.load();
    const pathHashes: Record<string, string> = {};
    for (const rel of req.paths) {
      const abs = this.safeAbs(rel);
      const digest = abs === undefined ? undefined : fileSha256(abs);
      if (digest !== undefined) pathHashes[rel.replace(/\\/g, "/")] = digest;
    }
    const ep: Episode = {
      key: req.key,
      kind: req.kind,
      model: req.model,
      prompt: req.prompt,
      paths: Object.freeze([...req.paths]),
      pathHashes: Object.freeze(pathHashes),
      result: req.result,
      tokensIn: req.tokensIn ?? 0,
      tokensOut: req.tokensOut ?? 0,
      ts: Date.now(),
    };
    this.episodes.set(ep.key, ep);
    this.pending = [...this.pending, ep.key];
    const appended = this.appendEpisode(ep);
    if (this.pending.length >= this.evolveEvery) void this.consolidate();
    return appended;
  }

  /** Zero-API-call replay — only while every recorded hash still matches. */
  replay(key: string): Episode | undefined {
    if (!this.enabled) return undefined;
    this.load();
    const ep = this.episodes.get(key);
    if (ep === undefined) {
      this.misses++;
      return undefined;
    }
    if (!this.hashesFresh(ep.pathHashes)) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    return ep;
  }

  private hashesFresh(pathHashes: Readonly<Record<string, string>>): boolean {
    for (const [rel, digest] of Object.entries(pathHashes)) {
      const abs = this.safeAbs(rel);
      if (abs === undefined) return false; // path escaped the root — treat as drifted
      if (fileSha256(abs) !== digest) return false;
    }
    return true;
  }

  private appendEpisode(ep: Episode): boolean {
    if (this.dir === undefined) return false;
    try {
      mkdirSync(dirname(join(this.dir, "episodes.jsonl")), { recursive: true });
      writeFileSync(join(this.dir, "episodes.jsonl"), `${JSON.stringify(ep)}\n`, { flag: "a" });
      if (this.episodes.size > EPISODE_CAP) this.rewriteEpisodes();
      return true;
    } catch {
      return false; // fail-soft: warn-free degradation
    }
  }

  private rewriteEpisodes(): void {
    if (this.dir === undefined) return;
    const keep = [...this.episodes.values()].sort((a, b) => b.ts - a.ts).slice(0, EPISODE_CAP);
    this.episodes = new Map(keep.map((e) => [e.key, e]));
    try {
      writeFileSync(
        join(this.dir, "episodes.jsonl"),
        keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length > 0 ? "\n" : ""),
      );
    } catch {
      // fail-soft: the append already succeeded; the trim retries on the next overflow
    }
  }

  // ── L2: notes ───────────────────────────────────────────────────────────────

  addNote(req: {
    readonly content: string;
    readonly paths?: readonly string[];
    readonly tags?: readonly string[];
    readonly context?: string;
    readonly symbols?: readonly string[];
    readonly sourceKeys?: readonly string[];
    readonly noteId?: string;
  }): Note | undefined {
    if (!this.enabled || this.dir === undefined || req.content.trim() === "") return undefined;
    this.load();
    const paths = req.paths ?? [];
    const id =
      req.noteId ?? createHash("sha256").update(`${req.content}|${paths.join(",")}`).digest("hex").slice(0, 16);
    const existing = this.notes.get(id);
    const toks = tokenize(req.content);
    const note: Note = {
      id,
      content: req.content.trim(),
      timestamp: Date.now(),
      keywords: Object.freeze(existing?.keywords ?? toks.slice(0, KEYWORDS_MAX)),
      tags: Object.freeze([...(req.tags ?? [])]),
      context: req.context ?? "",
      paths: Object.freeze([...paths]),
      symbols: Object.freeze([...(req.symbols ?? [])]),
      links: Object.freeze([...(existing?.links ?? [])]),
      sourceKeys: Object.freeze([...new Set([...(existing?.sourceKeys ?? []), ...(req.sourceKeys ?? [])])]),
    };
    // link-on-write: top-4 BM25 neighbors, bidirectional (merge for re-writes)
    const neighbors = this.bm25(note.content, [...this.notes.values()].filter((n) => n.id !== id), LINK_NEIGHBORS);
    const links = [...new Set([...note.links, ...neighbors.map(([n]) => n.id)])];
    this.notes.set(id, { ...note, links: Object.freeze(links) });
    for (const [n] of neighbors) {
      const back = this.notes.get(n.id);
      if (back !== undefined) {
        this.notes.set(n.id, { ...back, links: Object.freeze([...new Set([...back.links, id])]) });
      }
    }
    this.saveNotes();
    return this.notes.get(id);
  }

  /** BM25 retrieval over note blobs. */
  query(text: string, k = 8): readonly Note[] {
    if (!this.enabled) return [];
    this.load();
    return Object.freeze(this.bm25(text, [...this.notes.values()], k).map(([n]) => n));
  }

  private bm25(query: string, notes: readonly Note[], k: number): readonly [Note, number][] {
    if (notes.length === 0 || query.trim() === "") return [];
    const qTokens = new Set(tokenize(query));
    if (qTokens.size === 0) return [];
    const docs = notes.map((n) => tokenize(noteBlob(n)));
    const df = new Map<string, number>();
    for (const toks of docs) {
      for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = docs.length;
    const avgdl = docs.reduce((s, t) => s + t.length, 0) / Math.max(1, n);
    const k1 = 1.5;
    const b = 0.75;
    const scored = new Array<[Note, number]>(n);
    for (let i = 0; i < n; i++) {
      const toks = docs[i];
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      const dl = toks.length || 1;
      let score = 0;
      for (const q of qTokens) {
        const f = tf.get(q);
        if (f === undefined) continue;
        const idf = Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
      }
      scored[i] = [notes[i], score];
    }
    scored.sort((a, c) => c[1] - a[1] || (a[0].id < c[0].id ? -1 : 1));
    return scored.slice(0, k).filter(([, s]) => s > 0);
  }

  /** Batched A-MEM-lite: one prompt over every pending episode → note list; verbatim fallback.
   *  Single-flight (audit M2): overlapping recordEpisode bursts share ONE consolidation. */
  async consolidate(): Promise<number> {
    if (this.consolidating !== undefined) return this.consolidating;
    const run = this.doConsolidate().finally(() => {
      this.consolidating = undefined;
    });
    this.consolidating = run;
    return run;
  }

  private consolidating: Promise<number> | undefined;

  private async doConsolidate(): Promise<number> {
    if (!this.enabled || this.dir === undefined) return 0;
    this.load();
    const pendingEps = this.pending
      .map((k) => this.episodes.get(k))
      .filter((e): e is Episode => e !== undefined);
    if (pendingEps.length === 0) return 0;
    let made = 0;
    if (this.llm !== undefined) {
      try {
        const payload = JSON.stringify(
          pendingEps.map((e) => ({ prompt: e.prompt.slice(0, 200), answer: e.result.slice(0, 600), paths: e.paths })),
        );
        const raw = await this.llm(
          "Distill the following completed research episodes into durable notes. " +
            "Return STRICT JSON: an array of {content, tags, paths} objects (max 12, one line each, " +
            "no preamble). Episodes:\n" + payload,
        );
        // M2 (audit): try the whole reply as JSON first; only then fall back to slicing the
        // first bracket span out of prose. Item-level validation below rejects junk either way.
        const parsed: unknown = await (async (): Promise<unknown> => {
          try {
            return JSON.parse(raw.trim());
          } catch {
            const slice = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
            return slice === "" ? null : JSON.parse(slice);
          }
        })();
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "object" && item !== null) {
              const r = item as Record<string, unknown>;
              if (typeof r.content === "string") {
                this.addNote({
                  content: r.content,
                  tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
                  paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [],
                  sourceKeys: pendingEps.map((e) => e.key),
                });
                made++;
              }
            }
          }
        }
      } catch {
        made = 0; // fall through to the verbatim fallback below
      }
    }
    if (made === 0) {
      for (const e of pendingEps) {
        this.addNote({
          content: `${e.prompt.slice(0, 200)} → ${e.result.slice(0, 400)}`,
          paths: e.paths,
          tags: ["episode"],
          sourceKeys: [e.key],
        });
        made++;
      }
    }
    this.pending = [];
    return made;
  }

  /** v2 rule: silent when empty (v1 burned ~90 chars/turn teaching an empty store). */
  injectBlock(query: string, k = 6): string {
    const notes = this.query(query, k);
    if (notes.length === 0) {
      this.notesInjected = 0;
      return "";
    }
    const budget = this.injectNoteTokens * 4; // chars
    const lines: string[] = [INJECT_HEADER];
    let used = INJECT_HEADER.length;
    let kept = 0;
    for (const n of notes) {
      const chunk = `- ${n.id} tags=${n.tags.join(",") || "-"} paths=${n.paths.join(",") || "-"}: ${n.content.slice(0, NOTE_CONTENT_CHARS)}`;
      if (used + chunk.length > budget) break;
      lines.push(chunk);
      used += chunk.length;
      kept++;
    }
    this.notesInjected = kept;
    return kept > 0 ? lines.join("\n") : "";
  }

  stats(): MemoryStats {
    return Object.freeze({
      episodes: this.episodes.size,
      notes: this.notes.size,
      hits: this.hits,
      misses: this.misses,
      notesInjected: this.notesInjected,
    });
  }

  /** The ONE implementation of the sandbox `memory.query/add/stats` surface — the engine
   *  and the native repl tool both route their `memoryOp` interrupt here. */
  serviceOp(
    op: "query" | "add" | "stats",
    args: { readonly query?: string; readonly k?: number; readonly content?: string; readonly paths?: readonly string[]; readonly tags?: readonly string[] },
  ): string {
    if (!this.enabled) return "memory disabled";
    if (op === "stats") return JSON.stringify(this.stats());
    if (op === "add") {
      const n = this.addNote({ content: args.content ?? "", paths: args.paths ?? [], tags: args.tags ?? [] });
      return n === undefined ? "add skipped (empty content)" : `ok note ${n.id}`;
    }
    const notes = this.query(args.query ?? "", args.k ?? 8);
    if (notes.length === 0) return "no notes match";
    const lines = new Array<string>(notes.length);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      lines[i] = `- ${n.id} tags=${n.tags.join(",") || "-"} paths=${n.paths.join(",") || "-"}: ${n.content.slice(0, NOTE_CONTENT_CHARS)}`;
    }
    return lines.join("\n");
  }

  // ── persistence (fail-soft) ─────────────────────────────────────────────────

  private saveNotes(): void {
    if (this.dir === undefined) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const obj: Record<string, Note> = {};
      for (const [id, n] of this.notes) obj[id] = n;
      writeFileSync(join(this.dir, "notes.json"), JSON.stringify(obj));
    } catch {
      // fail-soft
    }
  }

  private load(): void {
    if (this.loaded || this.dir === undefined) return;
    this.loaded = true;
    try {
      const raw = readFileSync(join(this.dir, "episodes.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const ep = parseEpisode(JSON.parse(line) as unknown);
          if (ep !== undefined) this.episodes.set(ep.key, ep);
        } catch {
          // skip corrupt line — one bad append must not lose the store
        }
      }
    } catch {
      // no episodes yet
    }
    try {
      const rawNotes = JSON.parse(readFileSync(join(this.dir, "notes.json"), "utf8")) as unknown;
      if (typeof rawNotes === "object" && rawNotes !== null) {
        for (const v of Object.values(rawNotes as Record<string, unknown>)) {
          const n = parseNote(v);
          if (n !== undefined) this.notes.set(n.id, n);
        }
      }
    } catch {
      // no notes yet
    }
  }
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function strArr(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseEpisode(v: unknown): Episode | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.result !== "string") return undefined;
  const hashes: Record<string, string> = {};
  if (typeof r.pathHashes === "object" && r.pathHashes !== null) {
    for (const [k, h] of Object.entries(r.pathHashes as Record<string, unknown>)) {
      if (typeof h === "string") hashes[k] = h;
    }
  }
  return {
    key: r.key,
    kind: r.kind === "root" ? "root" : "rlm",
    model: str(r.model),
    prompt: str(r.prompt),
    paths: strArr(r.paths),
    pathHashes: hashes,
    result: r.result,
    tokensIn: num(r.tokensIn),
    tokensOut: num(r.tokensOut),
    ts: num(r.ts),
  };
}

function parseNote(v: unknown): Note | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.content !== "string") return undefined;
  return {
    id: r.id,
    content: r.content,
    timestamp: num(r.timestamp),
    keywords: strArr(r.keywords),
    tags: strArr(r.tags),
    context: str(r.context),
    paths: strArr(r.paths),
    symbols: strArr(r.symbols),
    links: strArr(r.links),
    sourceKeys: strArr(r.sourceKeys),
  };
}
