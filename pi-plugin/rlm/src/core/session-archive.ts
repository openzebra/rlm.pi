/**
 * Session archive (recall W1) — the model-reachable copy of elided root history.
 *
 * The root context transform (core/root-context.ts) stubs every turn older than the keep
 * window; before this module those bytes were unrecoverable — the session log is host-side
 * only and the repl sandbox never saw native read/bash payloads. The archive closes the
 * loop: every message the elision destroys is recorded here, rendered into markdown
 * segments, and materialized into the sandbox under `ctx/session-log/` through the SAME
 * upsert seam native edit/write uses (context/refresh.ts) — so the existing free
 * search() / grep_context() BM25 recall them (RLM paper §2: context stays an environment;
 * LLM-memory survey §5: query, not storage, is the recall bottleneck).
 *
 * The elision re-runs on EVERY provider call over a fresh clone, so records dedup by
 * content hash (the transcript is append-only; the same stale turn re-elides each call).
 * Segment materialization is idempotent per segment path and fail-soft end to end.
 */

import { truncateOutput } from "../text/parsing.ts";

/** Sandbox namespace the segments materialize under — one wording source for the stubs
 *  that teach recall (prompts/glossary.ts) and for the materialized paths. */
export const ARCHIVE_NAMESPACE = "ctx/session-log/";

/** Per-record cap: a 2MB tool payload is archived mid-truncated (head+tail) — recall needs
 *  the shape and the needles, not every byte (paper A.4 compact-serialization doctrine). */
const ARCHIVE_RECORD_MAX_CHARS = 100_000;
/** Host-memory ring cap (chars). Already-materialized segments live in the worker; this
 *  caps only the host copy. Configurable as `rootArchiveMaxChars` (0 = archive off). */
export const ARCHIVE_DEFAULT_MAX_CHARS = 2_000_000;
/** Dedup-set cap: FIFO eviction of the oldest hashes; a re-elided evicted message is
 *  re-recorded harmlessly (a duplicate segment entry, not a correctness issue). */
const HASH_SET_MAX = 8_192;

const ARCHIVE_TRUNCATE_MARK = "chars archived out — the middle never enters the archive";

export interface ArchivedEntry {
  readonly role: "assistant" | "toolResult";
  readonly toolName: string | undefined;
  readonly text: string;
}

/** FNV-1a 32-bit over role+name+text — the dedup key (same double-hash idiom as skillstate). */
function entryHash(entry: ArchivedEntry): string {
  const basis = `${entry.role}\u0000${entry.toolName ?? ""}\u0000${entry.text}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 ^ (c + i)) * 0x01000193;
    h1 >>>= 0;
    h2 >>>= 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

interface RingEntry {
  readonly seq: number;
  readonly hash: string;
  readonly entry: ArchivedEntry;
}

export interface ArchiveSegment {
  /** Unique context path for this segment (`ctx/session-log/turn-<a>-<b>.md`). */
  readonly path: string;
  readonly text: string;
}

export class SessionArchive {
  private ring: RingEntry[] = [];
  private readonly seen = new Map<string, true>();
  private totalChars = 0;
  private nextSeq = 1;
  private materializedThrough = 0;
  private lostWhilePending = 0;
  private pendingChars = 0;
  private pendingCount = 0;

  constructor(private readonly maxChars: number) {}

  /**
   * Record one elided message. Returns the assigned seq, or undefined for
   * empty/duplicate records. Per-record truncation applies BEFORE the ring cap.
   */
  record(entry: ArchivedEntry): number | undefined {
    const text = entry.text.trim();
    if (text === "") return undefined;
    const capped: ArchivedEntry = {
      ...entry,
      text: text.length > ARCHIVE_RECORD_MAX_CHARS
        ? truncateOutput(text, ARCHIVE_RECORD_MAX_CHARS, ARCHIVE_TRUNCATE_MARK)
        : text,
    };
    const hash = entryHash(capped);
    if (this.seen.has(hash)) return undefined;
    this.seen.set(hash, true);
    if (this.seen.size > HASH_SET_MAX) {
      // FIFO: Map preserves insertion order; drop the oldest hash only.
      const oldest = this.seen.keys().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    const seq = this.nextSeq++;
    this.ring.push({ seq, hash, entry: capped });
    this.totalChars += capped.text.length;
    if (seq > this.materializedThrough) {
      this.pendingChars += capped.text.length;
      this.pendingCount += 1;
    }
    this.evictOverCap();
    return seq;
  }

  /** True when unmaterialized records exist (flush when the sandbox is next alive). */
  get hasPending(): boolean {
    return this.pendingCount > 0;
  }

  get pendingCharsValue(): number {
    return this.pendingChars;
  }

  /** Telemetry: entries + chars currently held (host copy). */
  get stats(): { readonly entries: number; readonly chars: number; readonly recorded: number } {
    return { entries: this.ring.length, chars: this.totalChars, recorded: this.nextSeq - 1 };
  }

  /**
   * Render every unmaterialized record into ONE segment and mark it materialized.
   * Returns undefined when nothing is pending. The path embeds the covered seq range so
   * segments never collide and the `ctx/session-log/*` glob covers them all.
   */
  renderPending(): ArchiveSegment | undefined {
    const pending = this.ring.filter((r) => r.seq > this.materializedThrough);
    if (pending.length === 0) return undefined;
    const parts: string[] = [];
    if (this.lostWhilePending > 0) {
      parts.push(
        `(archive cap dropped ${this.lostWhilePending} older elided turn(s) before materialization)`,
      );
      this.lostWhilePending = 0;
    }
    for (const r of pending) {
      const label = r.entry.role === "toolResult" && r.entry.toolName !== undefined
        ? `${r.entry.role} (${r.entry.toolName})`
        : r.entry.role;
      parts.push(`### turn ${r.seq} — ${label}\n${r.entry.text}`);
    }
    const first = pending[0]?.seq ?? 0;
    const last = pending[pending.length - 1]?.seq ?? first;
    this.materializedThrough = last;
    this.pendingChars = 0;
    this.pendingCount = 0;
    return {
      path: `${ARCHIVE_NAMESPACE}turn-${first}-${last}.md`,
      text: parts.join("\n\n"),
    };
  }

  /** Ring eviction: drop OLDEST entries until under cap. Evicting an unmaterialized
   *  record loses it from recall — counted so the next segment says so honestly. */
  private evictOverCap(): void {
    while (this.totalChars > this.maxChars && this.ring.length > 1) {
      const oldest = this.ring[0];
      if (oldest === undefined) return;
      this.ring = this.ring.slice(1);
      this.totalChars -= oldest.entry.text.length;
      if (oldest.seq > this.materializedThrough) {
        this.pendingChars -= oldest.entry.text.length;
        this.pendingCount -= 1;
        this.lostWhilePending += 1;
      }
    }
  }
}
