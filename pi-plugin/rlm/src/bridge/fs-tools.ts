import { execFile, spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import type { FsLimits } from "../core/types.ts";
import type { RlmToolBridge } from "../tool/rlm-details.ts";
import { validateAnchorEdit, validateAnchorEditSet, type AnchorEdit } from "../text/edits.ts";

const execFileP = promisify(execFile);

const WALK_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", ".DS_Store",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".svelte-kit", ".astro", ".vite", ".expo",
  ".gradle", ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
  ".venv", "venv", "env", "__pycache__", ".serverless", ".terraform", ".yarn", ".pnpm-store",
  "node_modules", "bower_components", "vendor", "Pods", "DerivedData", "Carthage",
  "target", "dist", "build", "out", "coverage", ".coverage", "htmlcov", "tmp", "temp", "logs",
  "bin", "obj", "pkg", "elm-stuff", "deps", "_build", "zig-cache", "zig-out",
  ".eslintcache", ".stylelintcache", ".tsbuildinfo", "npm-debug.log", "yarn-error.log", "pnpm-debug.log",
]);

const WALK_SKIP_SUFFIXES = [
  ".pyc", ".pyo", ".class", ".o", ".obj", ".so", ".dylib", ".dll", ".exe",
  ".beam", ".hi", ".dyn_hi", ".dyn_o", ".rlib", ".rmeta", ".wasm",
  ".min.js", ".min.css", ".map", ".log", ".tmp", ".temp", ".cache",
];

function shouldSkipWalkEntry(name: string): boolean {
  return WALK_SKIP_NAMES.has(name) || WALK_SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function resolveWorkspacePath(root: string, path: string, allowOutsideWorkspace = false): string {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, path);
  if (!allowOutsideWorkspace) {
    const rel = relative(absRoot, abs);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel)))
      throw new Error(`path '${path}' is outside the workspace root`);
  }
  return abs;
}

export interface FsBridge {
  readFile(path: string, start: number | null, end: number | null): Promise<string>;
  grep(pattern: string, glob: string | null, maxMatches: number | null): Promise<string>;
  find(glob: string | null): Promise<string>;
  proposeEdit(path: string, oldText: string, newText: string, existingEdits: readonly AnchorEdit[]): Promise<string>;
}

export interface FsBridgeOptions {
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  initialFiles?: string[];
  bridge?: RlmToolBridge;
  parentId?: string;
  depth?: number;
  limits?: FsLimits;
  allowReadOutsideWorkspace?: boolean;
}

interface CommandOptions {
  signal?: AbortSignal;
  commandTimeoutMs: number;
  limits: FsLimits;
  allowReadOutsideWorkspace: boolean;
}

function safeResolve(root: string, path: string, allowOutsideWorkspace: boolean): string {
  const abs = resolve(root, path);
  if (allowOutsideWorkspace) return abs;
  const rel = relative(root, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path '${path}' is outside the workspace root`);
  return abs;
}

async function safeRealPath(root: string, path: string, opts: CommandOptions, rootReal?: string): Promise<string> {
  const abs = safeResolve(root, path, opts.allowReadOutsideWorkspace);
  const real = await realpath(abs);
  if (opts.allowReadOutsideWorkspace) return real;
  const realRoot = rootReal ?? await realpath(root);
  const rel = relative(realRoot, real);
  if (rel === "") return real;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path '${path}' is outside the workspace root`);
  return real;
}

export async function safeWorkspaceRealPath(root: string, path: string, allowOutsideWorkspace = false): Promise<string> {
  return safeRealPath(root, path, { ...commandOptions(), allowReadOutsideWorkspace: allowOutsideWorkspace });
}

function truncateOutput(text: string, limit = DEFAULT_CONFIG.fsLimits.maxOutputChars): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated to ${limit} characters]`;
}

function previewEdit(text: string, oldText: string, newText: string, path: string, offset: number): string {
  const line = text.slice(0, offset).split("\n").length;
  const removed = oldText.split("\n").length;
  const added = newText.split("\n").length;
  return `ok — ${path}:${line} (−${removed}/+${added} lines)`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("filesystem tool aborted");
}

function commandOptions(opts?: FsBridgeOptions): CommandOptions {
  const limits = { ...DEFAULT_CONFIG.fsLimits, ...opts?.limits };
  return {
    signal: opts?.signal,
    commandTimeoutMs: opts?.commandTimeoutMs ?? limits.commandTimeoutMs,
    limits,
    allowReadOutsideWorkspace: opts?.allowReadOutsideWorkspace ?? DEFAULT_CONFIG.allowReadOutsideWorkspace,
  };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missingFileMessage(path: string): string {
  return `'${path}' not found`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const prev = glob[i - 1];
        const next = glob[i + 2];
        if (prev === "/" && next === "/") {
          out = out.endsWith("/") ? out.slice(0, -1) : out;
          out += "(?:/.*)?/";
          i += 2;
        } else {
          i++;
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`${out}$`);
}

interface GrepCommandResult {
  lines: string[];
  truncated: boolean;
}

async function grepCommand(command: string, args: string[], cwd: string, cap: number, opts: CommandOptions): Promise<GrepCommandResult> {
  throwIfAborted(opts.signal);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let pending = "";
    let stderr = "";
    let capped = false;
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };
    const resolveOnce = (value: GrepCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };
    const abort = () => {
      child.kill("SIGTERM");
      rejectOnce(new Error("filesystem tool aborted"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.commandTimeoutMs);

    opts.signal?.addEventListener("abort", abort, { once: true });

    const stopIfCapped = () => {
      if (lines.length >= cap && !capped) {
        capped = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0 && lines.length < cap) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) lines.push(line);
        nl = pending.indexOf("\n");
      }
      stopIfCapped();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => rejectOnce(err));
    child.on("close", (code) => {
      if (settled) return;
      if (pending && lines.length < cap) lines.push(pending);
      if (timedOut) rejectOnce(new Error(`${command} exceeded ${opts.commandTimeoutMs}ms timeout`));
      else if (code === 0 || code === 1 || capped) resolveOnce({ lines, truncated: capped });
      else rejectOnce(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}


async function gitLsFiles(root: string, opts: CommandOptions): Promise<string[]> {
  throwIfAborted(opts.signal);
  const { stdout } = await execFileP("git", ["ls-files"], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    signal: opts.signal,
    timeout: opts.commandTimeoutMs,
  });
  return stdout.split("\n").filter(Boolean).slice(0, opts.limits.maxManifestFiles);
}

async function walkFiles(root: string, dir = ".", out: string[] = [], limit = DEFAULT_CONFIG.fsLimits.maxManifestFiles, opts = commandOptions()): Promise<string[]> {
  throwIfAborted(opts.signal);
  if (out.length >= limit) return out;
  const abs = safeResolve(root, dir, opts.allowReadOutsideWorkspace);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit || shouldSkipWalkEntry(entry.name)) continue;
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkFiles(root, path, out, limit, opts);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function listProjectFiles(root: string, limit = DEFAULT_CONFIG.fsLimits.maxManifestFiles, fsOpts?: FsBridgeOptions): Promise<string[]> {
  const absRoot = resolve(root);
  const opts = commandOptions(fsOpts);
  const load = async () => {
    try {
      return await gitLsFiles(absRoot, opts);
    } catch {
      return walkFiles(absRoot, ".", [], opts.limits.maxManifestFiles, opts);
    }
  };
  const files = await load();
  return files.slice(0, limit);
}

export async function buildProjectManifest(root: string, opts?: FsBridgeOptions): Promise<string> {
  const limits = { ...DEFAULT_CONFIG.fsLimits, ...opts?.limits };
  const files = await listProjectFiles(root, limits.maxManifestFiles, opts);
  if (files.length === 0) return "";
  return [
    `# Project map (${files.length} files, root: ${root})`,
    "# Use find(glob), grep(pattern[, glob]), read_file(path[, start, end]) to explore.",
    ...files,
  ].join("\n");
}

const isErr = (s: string): boolean => s.startsWith("Error:");

function previewRead(out: string): string {
  if (isErr(out)) return out;
  if (out.length === 0) return "0 lines · 0 chars";
  const lines = out.split("\n").length;
  return `${lines} line${lines === 1 ? "" : "s"} · ${out.length.toLocaleString()} chars`;
}

function previewGrep(out: string): string {
  if (isErr(out)) return out;
  if (out === "(no matches)") return "(no matches)";
  const lines = out.split("\n").filter((line) => line && !line.startsWith("…[truncated")).length;
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) files.add(line.slice(0, idx));
  }
  return `${lines} match${lines === 1 ? "" : "es"}${files.size > 0 ? ` in ${files.size} file${files.size === 1 ? "" : "s"}` : ""}`;
}

function previewFind(out: string): string {
  if (isErr(out)) return out;
  if (out === "(no files)") return "(no files)";
  const files = out.split("\n").filter((line) => line && !line.startsWith("…[truncated")).length;
  return `${files} file${files === 1 ? "" : "s"}`;
}

export function createFsBridge(root: string, fsOpts: FsBridgeOptions = {}): FsBridge {
  const opts = commandOptions(fsOpts);
  const bridge = fsOpts.bridge;
  let rootRealPromise: Promise<string> | undefined;
  let fileListPromise: Promise<string[]> | undefined;

  const rootReal = () => {
    rootRealPromise ??= realpath(root);
    return rootRealPromise;
  };
  const projectFiles = () => {
    fileListPromise ??= fsOpts.initialFiles ? Promise.resolve(fsOpts.initialFiles) : listProjectFiles(root, opts.limits.maxManifestFiles, fsOpts);
    return fileListPromise;
  };
  const formatGrepOutput = ({ lines, truncated }: GrepCommandResult, cap: number) => {
    if (lines.length === 0) return "(no matches)";
    const suffix = truncated ? `\n…[truncated to ${cap} matches]` : "";
    return truncateOutput(`${lines.slice(0, cap).join("\n")}${suffix}`, opts.limits.maxOutputChars);
  };

  return {
    async readFile(path, start, end) {
      const args = start != null || end != null ? `${path}:${start ?? ""}-${end ?? ""}` : path;
      const id = bridge?.addSubcall({ kind: "tool", parentId: fsOpts.parentId, label: "read_file", args, depth: fsOpts.depth });
      let out: string;
      try {
        const abs = await safeRealPath(root, path, opts, await rootReal());
        const st = await stat(abs);
        if (!st.isFile()) out = `Error: '${path}' is not a file`;
        else if (st.size > opts.limits.maxReadBytes) out = `Error: file '${path}' exceeds the ${opts.limits.maxReadBytes} byte limit`;
        else {
          const text = await readFile(abs, "utf8");
          if (start == null && end == null) out = text;
          else {
            const lines = text.split("\n");
            const a = Math.max(1, start ?? 1);
            const b = Math.min(lines.length, end ?? lines.length);
            out = b < a ? "" : truncateOutput(lines.slice(a - 1, b).join("\n"), opts.limits.maxOutputChars);
          }
        }
      } catch (e) {
        out = isEnoent(e) ? `Error: ${missingFileMessage(path)}` : `Error: ${errorMessage(e)}`;
      }
      if (bridge && id !== undefined) bridge.updateSubcall(id, {
        status: isErr(out) ? "error" : "done",
        detail: isErr(out) ? out : undefined,
        resultPreview: previewRead(out),
      });
      return out;
    },

    async proposeEdit(path, oldText, newText, existingEdits) {
      const id = bridge?.addSubcall({ kind: "tool", parentId: fsOpts.parentId, label: "propose_edit", args: path, depth: fsOpts.depth });
      let out: string;
      try {
        const abs = await safeRealPath(root, path, opts, await rootReal());
        const st = await stat(abs);
        if (!st.isFile()) out = `Error: '${path}' is not a file`;
        else if (st.size > opts.limits.maxReadBytes) out = `Error: file '${path}' exceeds the ${opts.limits.maxReadBytes} byte limit`;
        else {
          const text = await readFile(abs, "utf8");
          const candidate: AnchorEdit = { oldText, newText };
          const validation = validateAnchorEdit(text, path, candidate);
          if (!validation.ok) out = `Error: ${validation.error}`;
          else {
            const combined = [...existingEdits, candidate];
            const setValidation = validateAnchorEditSet(text, path, combined);
            out = setValidation.ok ? previewEdit(text, oldText, newText, path, validation.range.start) : `Error: ${setValidation.error}`;
          }
        }
      } catch (e) {
        out = isEnoent(e) ? `Error: ${missingFileMessage(path)}` : `Error: ${errorMessage(e)}`;
      }
      if (bridge && id !== undefined) bridge.updateSubcall(id, {
        status: isErr(out) ? "error" : "done",
        detail: isErr(out) ? out : undefined,
        resultPreview: out,
      });
      return out;
    },

    async grep(pattern, glob, maxMatches) {
      const cap = Math.min(Math.max(maxMatches ?? opts.limits.grepDefaultMaxMatches, 1), opts.limits.grepMaxMatchesCeiling);
      const id = bridge?.addSubcall({ kind: "tool", parentId: fsOpts.parentId, label: "grep", args: `"${pattern}" ${glob ?? "**/*"} (max ${cap})`, depth: fsOpts.depth });
      let out: string;
      try {
        const args = ["--line-number", "--no-heading", "--color=never"];
        if (glob) args.push("--glob", glob);
        args.push("-e", pattern, ".");
        const result = await grepCommand("rg", args, root, cap, opts);
        out = formatGrepOutput(result, cap);
      } catch (e) {
        if (!isEnoent(e)) out = `Error: grep failed (${errorMessage(e)})`;
        else {
          try {
            const args = ["grep", "-n", "-I", "-e", pattern];
            if (glob) args.push("--", `:(glob)${glob}`);
            const result = await grepCommand("git", args, root, cap, opts);
            out = formatGrepOutput(result, cap);
          } catch (e2) {
            out = `Error: grep unavailable (${errorMessage(e2)})`;
          }
        }
      }
      if (bridge && id !== undefined) bridge.updateSubcall(id, {
        status: isErr(out) ? "error" : "done",
        detail: isErr(out) ? out : undefined,
        resultPreview: previewGrep(out),
      });
      return out;
    },

    async find(glob) {
      const id = bridge?.addSubcall({ kind: "tool", parentId: fsOpts.parentId, label: "find", args: glob ?? "**/*", depth: fsOpts.depth });
      let out: string;
      try {
        let files = await projectFiles();
        if (glob) {
          const rx = globToRegExp(glob);
          files = files.filter((f) => rx.test(f));
        }
        const truncated = files.length > opts.limits.maxFindFiles;
        const shown = files.slice(0, opts.limits.maxFindFiles);
        const suffix = truncated ? `\n…[truncated to ${opts.limits.maxFindFiles} files]` : "";
        out = shown.length ? `${shown.join("\n")}${suffix}` : "(no files)";
      } catch (e) {
        out = `Error: ${errorMessage(e)}`;
      }
      if (bridge && id !== undefined) bridge.updateSubcall(id, {
        status: isErr(out) ? "error" : "done",
        detail: isErr(out) ? out : undefined,
        resultPreview: previewFind(out),
      });
      return out;
    },
  };
}
