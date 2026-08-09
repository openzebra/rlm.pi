/**
 * On-disk Markdown cache for anydoc conversions, keyed by (size, mtimeMs).
 *
 * Cache dir: $XDG_CACHE_HOME/pi-rlm/anydoc (else ~/.cache/…).
 * Per source: <name>-<sha8(absPath)>.md + .json stamp {source, size, mtimeMs}.
 *
 * The stamp is ALWAYS the pre-conversion (size, mtimeMs). Capturing after toMarkdown races
 * with mid-conversion edits and would stamp the new mtime against the old body — every future
 * read would be a permanent stale hit. writeMdCache also refuses to write when a post-conversion
 * stat disagrees with the captured stamp.
 *
 * Write ordering is load-bearing: Markdown body first, stamp second. A crash between them
 * leaves stale-body-no-stamp, which reads as a miss. All cache failures are swallowed —
 * the cache is an optimisation, never a dependency.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

interface CacheStamp {
  readonly source: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (typeof xdg === "string" && xdg.trim() !== "") return join(xdg, "pi-rlm", "anydoc");
  return join(homedir(), ".cache", "pi-rlm", "anydoc");
}

function entryBase(absPath: string): string {
  const name = basename(absPath).replace(/[^\w.-]+/g, "-").slice(0, 80) || "doc";
  const sha8 = createHash("sha256").update(absPath).digest("hex").slice(0, 8);
  return `${name}-${sha8}`;
}

function isStamp(value: unknown): value is CacheStamp {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.source === "string"
    && typeof r.size === "number"
    && typeof r.mtimeMs === "number";
}

/** Capture (size, mtimeMs) for a source file. Returns undefined on I/O failure. */
export async function captureStamp(absPath: string): Promise<FileStamp | undefined> {
  try {
    const s = await stat(absPath);
    return Object.freeze({ size: s.size, mtimeMs: s.mtimeMs });
  } catch {
    return undefined;
  }
}

/**
 * Read a cached Markdown body if the stamp still matches a fresh stat of `absPath`.
 * Returns undefined on any miss or I/O failure.
 */
export async function readMdCache(absPath: string): Promise<string | undefined> {
  try {
    const base = join(cacheRoot(), entryBase(absPath));
    const stampRaw = await readFile(`${base}.json`, "utf-8");
    const stamp: unknown = JSON.parse(stampRaw);
    if (!isStamp(stamp)) return undefined;
    const s = await stat(absPath);
    if (s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs) return undefined;
    return await readFile(`${base}.md`, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Write Markdown body then the PRE-CAPTURED stamp. Failures are swallowed.
 *
 * If a post-conversion stat disagrees with `stamp`, the write is skipped (file changed
 * mid-conversion — stamping the new mtime against the old body would freeze stale content).
 * Body-before-stamp is load-bearing (see module docstring).
 */
export async function writeMdCache(
  absPath: string,
  markdown: string,
  stamp: FileStamp,
): Promise<void> {
  try {
    // Refuse to cache if the source moved under us during conversion.
    const s = await stat(absPath);
    if (s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs) return;

    const root = cacheRoot();
    await mkdir(root, { recursive: true });
    const base = join(root, entryBase(absPath));
    // Body first, stamp second — crash between leaves a miss, never a wrong hit.
    await writeFile(`${base}.md`, markdown, "utf-8");
    const out: CacheStamp = Object.freeze({
      source: absPath,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
    });
    await writeFile(`${base}.json`, `${JSON.stringify(out)}\n`, "utf-8");
  } catch {
    // optimisation only
  }
}
