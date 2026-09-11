/**
 * Dataset access for the paper-tier suites (oolong / browsecomp / codeqa_lb).
 *
 * The lab downloaded these from HuggingFace at runtime (`datasets.load_dataset(..., streaming)`);
 * the bun equivalent is the public datasets-server /rows API (no key). Tasks are built once and
 * cached under bench/data/ — downloaded only if missing; the directory is gitignored. Delete a
 * cache file to force a re-download.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_DIR = fileURLToPath(new URL("./data/", import.meta.url));
const HF_ROWS = "https://datasets-server.huggingface.co/rows";
/** Small pages: browsecomp-plus rows are multi-MB (full documents), and huge pages can be
 *  rejected by the server — same effect as the lab's streaming row scan, just paged. */
const PAGE_SIZE = 5;

export type HfRow = Record<string, unknown>;

interface RowsPage {
  readonly rows?: readonly { readonly row?: HfRow }[];
}

/**
 * datasets-server paging is flaky under load: rapid small requests trip the 429 quota and some
 * slices 500 mid-scan. fetchPage retries patiently (long sleep on 429); on persistent 5xx the
 * caller halves the page size and retries the same offset.
 */
async function fetchPage(url: string, attempts = 5): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url);
    if (res.ok || i >= attempts || (res.status < 500 && res.status !== 429)) return res;
    const sleepMs = res.status === 429 ? 15_000 : 3_000 * i;
    console.log(`[data] hf retry ${i}/${attempts - 1} (HTTP ${res.status}, waiting ${sleepMs / 1000}s)`);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

export async function* hfRows(
  dataset: string,
  split: string,
  pageSize: number = PAGE_SIZE,
): AsyncGenerator<HfRow> {
  let offset = 0;
  let size = pageSize;
  for (;;) {
    const qs = new URLSearchParams({
      dataset,
      config: "default",
      split,
      offset: String(offset),
      length: String(size),
    });
    const res = await fetchPage(`${HF_ROWS}?${qs.toString()}`);
    if (!res.ok && res.status >= 500 && size > 1) {
      size = Math.max(1, Math.floor(size / 2));
      console.log(`[data] hf page -> ${size} rows after HTTP ${res.status}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (!res.ok) throw new Error(`datasets-server ${res.status} for ${dataset} @${offset}`);
    const page = (await res.json()) as RowsPage;
    const rows = page.rows ?? [];
    for (const entry of rows) {
      const row = entry.row;
      if (row) yield row;
    }
    if (rows.length < size) return;
    offset += size;
  }
}

export function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Download-if-missing task cache. `build()` only runs on a cache miss; the stored shape must be
 * JSON-serializable (no RegExp/functions — map cached records to BenchTask afterwards).
 */
export async function cachedTasks<T>(
  key: string,
  build: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  const file = `${DATA_DIR}${key}.json`;
  if (existsSync(file)) {
    console.log(`[data] ${key}: using cached tasks (${file})`);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`corrupt bench cache: ${file}`);
    return parsed as T[];
  }
  console.log(`[data] ${key}: not cached — downloading from HuggingFace (${key})...`);
  const tasks = await build();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(tasks), "utf8");
  console.log(`[data] ${key}: cached ${tasks.length} tasks -> ${file}`);
  return tasks;
}

/**
 * Slice a smaller task set out of an already-cached pool (e.g. n18@cl16384 out of the
 * n24@cl65536 pool) so smoke/ladder runs never re-scan HuggingFace. Deterministic: pick the
 * MOST INCLUSIVE cached pool (largest cl, tie-break larger n), filter its records by
 * contextLen ≤ maxContextLen (every cl-capped pool stores each record's own contextLen),
 * first `rows` of the preserved source order — identical to what a fresh HF scan yields.
 *
 * P0 / 附 D.1: the slice fast path must also recognise the LABELED cache family, else a small
 * labeled run (n<24) silently re-scans HuggingFace. Both spellings the plan writes are
 * accepted — `oolong_synth_lab_cl<n>_n<rows>` (§P0 cacheKey + the acceptance script's file name)
 * and `oolong_lab_synth_cl<n>_n<rows>` (附D.1's regex/cacheKey). Neither of the plan's two
 * literal regexes matches its own sibling name, so this single alternation covers both; the
 * family guard then makes cross-family hits impossible — the silent reuse of the unlabeled
 * slice is exactly the trap §P0 names (“为什么必须新 key”).
 */
const OOLONG_CACHE_RE = /^oolong_(?:lab_)?synth(?:_lab)?_cl(\d+)_n(\d+)\.json$/;

export function cachedTaskSlice<T>(
  rows: number,
  maxContextLen: number,
  opts?: { readonly labels?: boolean },
): readonly T[] | undefined {
  if (!existsSync(DATA_DIR)) return undefined;
  const wantLabels = opts?.labels === true;
  let bestName: string | undefined;
  let bestCl = -1;
  let bestN = 0;
  for (const name of readdirSync(DATA_DIR)) {
    const m = OOLONG_CACHE_RE.exec(name);
    if (m === null) continue;
    if (name.includes("lab_") !== wantLabels) continue; // ← 变体必须匹配
    const cl = Number(m[1]);
    const n = Number(m[2]);
    if (cl > bestCl || (cl === bestCl && n > bestN)) {
      bestCl = cl;
      bestN = n;
      bestName = name;
    }
  }
  if (bestName === undefined) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(`${DATA_DIR}${bestName}`, "utf8"));
  if (!Array.isArray(parsed)) return undefined;
  const filtered = (parsed as readonly (T & { contextLen: number })[]).filter(
    (r) => r.contextLen <= maxContextLen,
  );
  console.log(`[data] slicing ${Math.min(rows, filtered.length)}/${filtered.length} tasks (cl≤${maxContextLen}${wantLabels ? ", labels" : ""}) from cached ${bestName}`);
  return filtered.slice(0, rows);
}
