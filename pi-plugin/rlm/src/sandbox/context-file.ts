/**
 * Temp-file transport for sandbox context payloads, with refcounted sharing.
 *
 * Two callers, two ownership models, one writer:
 *  - `writeContextTempFile` — non-owning. `load_library` uses it because the WORKER unlinks
 *    that file after reading it (see sandbox.ts serviceInterrupt / worker.py `_load_library`).
 *  - `pinContext` — refcounted. Every child RLM of one node inherits the SAME payload, so an
 *    18-way fan-out would otherwise cost 18 serializations and 18 files. Pins are keyed by
 *    payload identity, which is a free version key: `mergeLibraryIntoContext` always returns a
 *    NEW array, so loading a library mints a new key and old holders keep their own file.
 *
 * Serialization is chunked with an await between chunks so the event loop is never blocked for
 * more than ~SERIALIZE_CHUNK entries. A Worker Thread was considered and rejected: posting the
 * payload structured-clones the whole array, which costs about what the stringify costs and
 * doubles peak RSS.
 */

import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Entries serialized per await. Bounds the longest synchronous span on the event loop. */
const SERIALIZE_CHUNK = 64;

/** A temp file on disk holding a serialized context payload. */
export interface ContextTempFile {
  readonly path: string;
  /** True when the file holds JSON; false when the payload was a raw string. */
  readonly json: boolean;
}

/** A shared, refcounted context file. Every holder must `release()` exactly once. */
export interface PinnedContext extends ContextTempFile {
  /** Drop this holder's reference; unlinks once the last holder releases. Idempotent. */
  release(): Promise<void>;
}

interface PinEntry extends ContextTempFile {
  refs: number;
}

/**
 * Live pins keyed by payload identity, storing the in-flight PROMISE rather than the settled
 * entry. Children of one node race here (each drives its own sandbox, so nothing else
 * serializes them); inserting the promise before the first await makes them join one write
 * instead of each starting their own and orphaning the loser's file.
 */
const pins = new Map<unknown, Promise<PinEntry>>();

function tempPath(isJson: boolean): string {
  const suffix = isJson ? "json" : "txt";
  return join(
    tmpdir(),
    `rlm-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`,
  );
}

/** Write a JSON array incrementally, yielding to the event loop between chunks. */
async function writeChunkedArray(handle: FileHandle, items: readonly unknown[]): Promise<void> {
  await handle.write("[");
  const buf = new Array<string>(SERIALIZE_CHUNK);
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    // Comma prefix beats trimming a trailing one; no `+=` accumulation anywhere.
    buf[n++] = i === 0 ? JSON.stringify(items[i]) : `,${JSON.stringify(items[i])}`;
    if (n === SERIALIZE_CHUNK) {
      await handle.write(buf.join("")); // the await is the yield point
      n = 0;
    }
  }
  if (n > 0) await handle.write(buf.slice(0, n).join(""));
  await handle.write("]");
}

/**
 * Serialize a payload to a fresh temp file. The caller owns the file and decides when (or
 * whether) to unlink it.
 */
export async function writeContextTempFile(payload: unknown): Promise<ContextTempFile> {
  const json = typeof payload !== "string";
  const path = tempPath(json);
  try {
    const handle = await open(path, "w");
    try {
      if (typeof payload === "string") await handle.write(payload);
      else if (Array.isArray(payload)) await writeChunkedArray(handle, payload);
      else await handle.write(JSON.stringify(payload));
    } finally {
      await handle.close();
    }
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
  return Object.freeze({ path, json });
}

async function writePinEntry(payload: unknown): Promise<PinEntry> {
  const file = await writeContextTempFile(payload);
  return { path: file.path, json: file.json, refs: 1 };
}

/** One holder's view of a pin. `shared` entries are evicted from the map at refcount zero. */
function handleFor(key: unknown, entry: PinEntry, shared: boolean): PinnedContext {
  let released = false;
  return Object.freeze({
    path: entry.path,
    json: entry.json,
    release: async (): Promise<void> => {
      if (released) return; // idempotent per handle, so a `finally` cannot double-decrement
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      if (shared) pins.delete(key);
      await unlink(entry.path).catch(() => {});
    },
  });
}

/**
 * Acquire a shared context file for `payload`. Holders must `release()` exactly once; the file
 * is unlinked when the last one does.
 */
export async function pinContext(payload: unknown): Promise<PinnedContext> {
  // Only arrays are shared. Their identity is a meaningful version key; a string's is not
  // (two equal strings may or may not be the same reference), and the string payloads here are
  // one-off child prompts with nothing to share anyway.
  if (!Array.isArray(payload)) {
    return handleFor(payload, await writePinEntry(payload), false);
  }

  const existing = pins.get(payload);
  if (existing !== undefined) {
    const entry = await existing;
    entry.refs += 1;
    return handleFor(payload, entry, true);
  }

  // Insert synchronously, BEFORE any await, so a concurrent caller sees this write in flight.
  const pending = writePinEntry(payload);
  pins.set(payload, pending);
  try {
    return handleFor(payload, await pending, true);
  } catch (err) {
    // Evict the rejected promise so a later caller retries instead of awaiting a poisoned pin.
    pins.delete(payload);
    throw err;
  }
}

/** Live pin count. Exported for tests asserting the sharing and the unlink-once behaviour. */
export function pinnedCount(): number {
  return pins.size;
}
