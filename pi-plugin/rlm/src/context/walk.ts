/**
 * Native repository walker — replaces repomix.
 *
 * git ls-files -co --exclude-standard -z IS gitignore semantics, not an approximation.
 * -z because a path may legally contain a newline. Tracked-but-deleted paths are listed too;
 * they fail the later read with ENOENT and are dropped there (reason "unreadable").
 * Returns undefined when not a git work tree → caller falls back to walkFs.
 *
 * A second net beneath .gitignore: isSensitivePath() denies secrets (.env*, keys, .ssh/, .aws/)
 * that repomix used to drop via useDefaultPatterns. Applied by packDirectory, not here —
 * enumeration is pure listing; the router reports skipped: "sensitive".
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SkipReason } from "./types.ts";

const execFileP = promisify(execFile);

/** 8KB probe window for the NUL-byte binary check. */
const BINARY_PROBE_BYTES = 8 * 1024;

/**
 * Directory names ignored by the non-git fallback walk. Dot-directories are skipped
 * by default (see walkFs) except DOT_DIR_ALLOWED; this set covers non-dot noise.
 * Growing array is the one walkFs exception (size unknown a priori).
 */
const FALLBACK_IGNORED: ReadonlySet<string> = Object.freeze(new Set([
  "node_modules", "dist", "build", "out", "coverage",
  "__pycache__", "venv",
]));

/**
 * Dot-directories still walked on the non-git fallback. Git trees are unaffected
 * (ls-files already lists .github/workflows etc. when tracked/unignored).
 */
const DOT_DIR_ALLOWED: ReadonlySet<string> = Object.freeze(new Set([
  ".github",
]));

/**
 * Deny-list beneath .gitignore. Secrets that must never enter context (and therefore never
 * reach a third-party sub-LLM API). Checked against every relative path in packDirectory.
 */
const SENSITIVE_BASENAME = Object.freeze([
  /^\.env$/i,
  /^\.env\..+/i,
  /^id_rsa/i,
  /^id_dsa/i,
  /^id_ecdsa/i,
  /^id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^netrc$/i,
  /^\.git-credentials$/i,
]);

const SENSITIVE_DIR_SEGMENTS: ReadonlySet<string> = Object.freeze(new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".docker",
]));

/**
 * True when a cwd-relative path must not enter context.
 * Matches basenames (.env*, *.pem, id_rsa*, …) and any path under .ssh/ .aws/ etc.
 */
export function isSensitivePath(relPath: string): boolean {
  // Match on the path as-is. git ls-files -z already emits forward-slashed paths;
  // walkFs normalises to POSIX. Do NOT rewrite backslashes — a POSIX filename may contain `\`.
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg !== undefined && SENSITIVE_DIR_SEGMENTS.has(seg)) return true;
  }
  const base = basename(relPath);
  for (let i = 0; i < SENSITIVE_BASENAME.length; i++) {
    if (SENSITIVE_BASENAME[i].test(base)) return true;
  }
  return false;
}

/** Absolute path with no trailing slash (except root). */
function absKey(path: string): string {
  const r = resolve(path);
  return r.length > 1 && (r.endsWith("/") || r.endsWith("\\")) ? r.slice(0, -1) : r;
}

/** True when `fileAbs` is `rootAbs` or a descendant (prefix + separator). */
export function isInsideRoot(fileAbs: string, rootAbs: string): boolean {
  const root = absKey(rootAbs);
  const file = absKey(fileAbs);
  if (file === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return file.startsWith(prefix);
}

export type PathSafety =
  | { readonly ok: true; readonly realAbs: string }
  | { readonly ok: false; readonly reason: Extract<SkipReason, "sensitive" | "symlink-escape" | "unreadable"> };

/**
 * lstat first; for symlinks, realpath and refuse targets that escape `packRoot` or land on
 * a sensitive path. isSensitivePath on the link name alone is not enough — `notes.txt →
 * /tmp/prod.env` would otherwise leak secrets past the deny-list.
 */
export async function checkPathSafety(absPath: string, packRoot: string): Promise<PathSafety> {
  try {
    const rootReal = await realpath(packRoot).catch(() => absKey(packRoot));
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      let realAbs: string;
      try {
        realAbs = await realpath(absPath);
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      if (!isInsideRoot(realAbs, rootReal)) {
        return { ok: false, reason: "symlink-escape" };
      }
      // Sensitive check on the resolved path (relative to pack root) AND its basename.
      const relFromRoot = relative(rootReal, realAbs).split(sep).join("/");
      if (isSensitivePath(relFromRoot) || isSensitivePath(basename(realAbs))) {
        return { ok: false, reason: "sensitive" };
      }
      return { ok: true, realAbs };
    }
    // Non-symlink: still resolve for a stable absolute path.
    const realAbs = await realpath(absPath).catch(() => absKey(absPath));
    return { ok: true, realAbs };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * List tracked + untracked, non-ignored files via git. Returns undefined when `cwd` is not a
 * git work tree (or git is unavailable) so the caller can fall back to walkFs.
 *
 * Paths are returned raw from git (forward-slashed). Sensitive paths are NOT filtered here —
 * packDirectory reports them as skipped: "sensitive" so the drop is visible.
 */
export async function gitFiles(cwd: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd, signal, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
    );
    if (stdout.length === 0) return Object.freeze([]);
    // Split on NUL; drop the trailing empty segment git always emits after the last path.
    // git ls-files -z emits raw unescaped paths, already forward-slashed — never rewrite `\`.
    const parts = stdout.toString("utf-8").split("\0");
    const out = new Array<string>(parts.length);
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p !== undefined && p !== "") out[n++] = p;
    }
    out.length = n;
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

/**
 * Stack-based recursive walk. Skips:
 *  - FALLBACK_IGNORED non-dot dirs (node_modules, dist, …)
 *  - Dot-directories except DOT_DIR_ALLOWED (.github) — .ssh/.aws/.git stay off the walk
 * Returns cwd-relative POSIX paths. Sensitive *files* and escaping symlinks are reported
 * by packDirectory after checkPathSafety.
 */
export async function walkFs(root: string, signal?: AbortSignal): Promise<readonly string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (signal?.aborted) break;
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      // Explicit encoding keeps Dirent.name as string under @types/node ≥20.
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === "." || name === "..") continue;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (FALLBACK_IGNORED.has(name)) continue;
        // Dot-dirs blocked except carve-outs (.github/workflows is often the analysis target).
        if (name.startsWith(".") && !DOT_DIR_ALLOWED.has(name)) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      if (rel !== "" && !rel.startsWith("..")) files.push(rel);
    }
  }
  return Object.freeze(files);
}

/**
 * Open once, read 8KB, return true if any NUL byte is present.
 * Failures (unreadable, gone) return false — the later text read will surface ENOENT.
 */
export async function isBinary(absPath: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(absPath, "r");
    const buf = Buffer.allocUnsafe(BINARY_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Enumerate files under `root`: git ls-files when possible, walkFs otherwise.
 * Paths are cwd-relative POSIX.
 */
export async function enumerateFiles(root: string, signal?: AbortSignal): Promise<readonly string[]> {
  const fromGit = await gitFiles(root, signal);
  if (fromGit !== undefined) return fromGit;
  return await walkFs(root, signal);
}

/** True when a path exists and is a regular file (or symlink to one). */
export async function isRegularFile(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile();
  } catch {
    return false;
  }
}
