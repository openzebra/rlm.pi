/**
 * Dataset access for the paper-tier suites (oolong / browsecomp / codeqa_lb).
 *
 * The lab downloaded these from HuggingFace at runtime (`datasets.load_dataset(..., streaming)`);
 * the bun equivalent is the public datasets-server /rows API (no key). Tasks are built once and
 * cached under bench/data/ — downloaded only if missing; the directory is gitignored. Delete a
 * cache file to force a re-download.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export async function* hfRows(dataset: string, split: string): AsyncGenerator<HfRow> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const qs = new URLSearchParams({
      dataset,
      config: "default",
      split,
      offset: String(offset),
      length: String(PAGE_SIZE),
    });
    const res = await fetch(`${HF_ROWS}?${qs.toString()}`);
    if (!res.ok) throw new Error(`datasets-server ${res.status} for ${dataset} @${offset}`);
    const page = (await res.json()) as RowsPage;
    const rows = page.rows ?? [];
    for (const entry of rows) {
      const row = entry.row;
      if (row) yield row;
    }
    if (rows.length < PAGE_SIZE) return;
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
