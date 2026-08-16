/**
 * Model context-window registry (port of rlm_test v4/v5 `models.py`).
 *
 * The plugin already knows context windows from model metadata (`Model.contextWindow`); this
 * registry is the offline fallback for models whose metadata carries none: a conservative
 * static table plus an optional disk cache at `<root>/.rlm/models_cache.json` (24h TTL).
 * All I/O is fail-soft — a missing/corrupt cache degrades to the table, never throws.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Conservative offline table (v5 verbatim). Unknown models get UNKNOWN_CONTEXT. */
const FALLBACK_CONTEXT: Readonly<Record<string, number>> = Object.freeze({
  "openai/gpt-5": 400_000,
  "openai/gpt-5-mini": 400_000,
  "anthropic/claude-sonnet-4.5": 200_000,
  "google/gemini-2.5-pro": 1_000_000,
  "qwen/qwen3-coder": 262_000,
  "deepseek/deepseek-chat": 128_000,
});

export const UNKNOWN_CONTEXT = 32_000;
const CACHE_TTL_MS = 86_400_000; // 24h
const CACHE_MAX_BYTES = 1 << 20; // refuse absurd caches rather than parse them

interface CacheEntry {
  readonly ctx: number;
  readonly ts: number;
}
type CacheFile = Readonly<Record<string, CacheEntry>>;

/** `<root>/.rlm/models_cache.json` — the single cache path helper (also used by memory). */
export function modelsCachePath(root: string): string {
  return `${root.replace(/\/+$/, "")}/.rlm/models_cache.json`;
}

export class ModelContextRegistry {
  private cache: CacheFile | undefined;
  private cacheLoaded = false;

  constructor(private readonly cachePath: string | undefined) {}

  /** Context window for "provider/id", falling back through cache → table → 32k. */
  limitFor(modelId: string): number {
    const hit = this.readCache()[modelId];
    if (hit !== undefined && Date.now() - hit.ts < CACHE_TTL_MS && hit.ctx > 0) return hit.ctx;
    return FALLBACK_CONTEXT[modelId] ?? UNKNOWN_CONTEXT;
  }

  /** Record a freshly observed window (fail-soft: a failed write only skips the cache). */
  observe(modelId: string, ctx: number): boolean {
    if (!(ctx > 0)) return false;
    const next: Record<string, CacheEntry> = { ...this.readCache(), [modelId]: { ctx, ts: Date.now() } };
    this.cache = next;
    if (this.cachePath === undefined) return false;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(next));
      return true;
    } catch {
      return false; // fail-soft: warn-free degradation to the static table
    }
  }

  private readCache(): CacheFile {
    if (this.cacheLoaded) return this.cache ?? {};
    this.cacheLoaded = true;
    if (this.cachePath === undefined) return {};
    try {
      const raw = readFileSync(this.cachePath, "utf8");
      if (raw.length > CACHE_MAX_BYTES) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, CacheEntry> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null) {
          const e = v as Record<string, unknown>;
          if (typeof e.ctx === "number" && typeof e.ts === "number") out[k] = { ctx: e.ctx, ts: e.ts };
        }
      }
      this.cache = out;
      return out;
    } catch {
      return {}; // missing or corrupt → static table
    }
  }
}
