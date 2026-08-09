/**
 * Shallow-clone a git URL, then pack with source-dir.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage, type Result } from "../util/errors.ts";
import { contextSourceId, pathPrefixFor } from "./namespace.ts";
import { packDirectory } from "./source-dir.ts";
import type { ResolveOpts, SourceResult } from "./types.ts";

const execFileP = promisify(execFile);

/** Shallow-clone `url` into a temp dir, pack, then remove the clone. */
export async function sourceGit(
  url: string,
  opts: ResolveOpts,
): Promise<Result<SourceResult, string>> {
  const dir = await mkdtemp(join(tmpdir(), "rlm-ctx-"));
  const sourceId = contextSourceId(url);
  const pathPrefix = opts.pathPrefix !== undefined ? opts.pathPrefix : pathPrefixFor(sourceId);
  try {
    await execFileP("git", ["clone", "--depth", "1", "--", url, dir], {
      signal: opts.signal,
      timeout: 120_000,
      // Never stall on a credential helper for a private URL — fail fast instead.
      env: Object.freeze({ ...process.env, GIT_TERMINAL_PROMPT: "0" }),
    });
    const packed = await packDirectory(dir, pathPrefix, opts.signal);
    return {
      ok: true,
      value: Object.freeze({
        payload: packed.files,
        files: packed.files.length,
        chars: packed.chars,
        sourceId,
        pathPrefix,
        documents: packed.documents,
        converted: packed.converted,
        skipped: packed.skipped,
      }),
    };
  } catch (err: unknown) {
    return { ok: false, error: `git clone failed for ${url} — ${errorMessage(err)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
