/**
 * Resolve load_library(source) into a sandbox-ready payload.
 *
 * Sources: local directory (repomix-packed), single file (utf-8 string), or
 * remote git URL (shallow clone then pack). Host-side only — never runs in the sandbox.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { packRepository, serializeForSandbox, type ContextBundle } from "./repomix-context.ts";
import type { Result } from "../util/errors.ts";
import { errorMessage } from "../util/errors.ts";

const execFileP = promisify(execFile);

export interface LibrarySource {
  readonly payload: unknown;     // str for a single file; ContextFile[] for a packed dir/repo
  readonly files?: number;       // undefined for single-file payloads
  readonly chars: number;
}

/** https://host/… or git@host:… — option-injection safe (never starts with "-"). */
const GIT_URL = /^(https:\/\/|git@)[\w.-]+[:/]\S+$/;

export async function resolveLibrarySource(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result<LibrarySource, string>> {
  const trimmed = source.trim();
  if (trimmed === "") return { ok: false, error: "load_library: empty source" };
  if (GIT_URL.test(trimmed)) return await cloneAndPack(trimmed, signal);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { ok: false, error: `unsupported URL scheme (only https:// and git@ are allowed): ${trimmed}` };
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(path);
  } catch {
    return { ok: false, error: `load_library: path not found: ${path}` };
  }
  if (s.isDirectory()) return await packDir(path, signal);
  const text = await readFile(path, "utf-8");
  return { ok: true, value: { payload: text, chars: text.length } };
}

async function packDir(dir: string, signal?: AbortSignal): Promise<Result<LibrarySource, string>> {
  const packed = await packRepository(dir, signal);       // repomix + existing per-path cache
  if (!packed.ok) return { ok: false, error: `pack failed for ${dir} — ${packed.error}` };
  return { ok: true, value: bundleToSource(packed.value) };
}

function bundleToSource(bundle: ContextBundle): LibrarySource {
  const payload = serializeForSandbox(bundle);
  // Match slot-0 contextLength for object/array payloads: JSON-serialized size,
  // not sum-of-content-lengths (bundle.totalChars), so the model sees one ruler.
  return {
    payload,
    files: bundle.totalFiles,
    chars: JSON.stringify(payload).length,
  };
}

async function cloneAndPack(url: string, signal?: AbortSignal): Promise<Result<LibrarySource, string>> {
  const dir = await mkdtemp(join(tmpdir(), "rlm-lib-"));
  try {
    // "--" terminates options; URL regex already forbids a leading dash.
    await execFileP("git", ["clone", "--depth", "1", "--", url, dir], { signal, timeout: 120_000 });
    return await packDir(dir, signal);
  } catch (err: unknown) {
    return { ok: false, error: `git clone failed for ${url} — ${errorMessage(err)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
