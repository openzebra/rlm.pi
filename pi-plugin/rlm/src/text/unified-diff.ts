/** Strict, dependency-free parser and applicator for git-style unified diffs. */

export type UnifiedDiffLineKind = "context" | "add" | "remove";

export interface UnifiedDiffLine {
  readonly kind: UnifiedDiffLineKind;
  readonly text: string;
}

export interface UnifiedDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly section?: string;
  readonly lines: readonly UnifiedDiffLine[];
}

interface MutableUnifiedDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly section?: string;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
  readonly oldPath: string;
  readonly newPath: string;
  readonly path: string;
  readonly hunks: readonly UnifiedDiffHunk[];
  readonly isNewFile: boolean;
  readonly isDeletedFile: boolean;
}

export interface ParseUnifiedDiffSuccess {
  readonly ok: true;
  readonly files: readonly UnifiedDiffFile[];
}

export interface UnifiedDiffFailure {
  readonly ok: false;
  readonly error: string;
}

export type ParseUnifiedDiffResult = ParseUnifiedDiffSuccess | UnifiedDiffFailure;

export interface ApplyUnifiedDiffSuccess {
  readonly ok: true;
  readonly text: string;
  readonly applied: number;
}

export type ApplyUnifiedDiffResult = ApplyUnifiedDiffSuccess | UnifiedDiffFailure;

export interface ApplyUnifiedDiffFileResult {
  readonly path: string;
  readonly text: string;
  readonly applied: number;
  readonly deleted: boolean;
}

export interface ApplyUnifiedDiffSetSuccess {
  readonly ok: true;
  readonly files: readonly ApplyUnifiedDiffFileResult[];
}

export type ApplyUnifiedDiffSetResult = ApplyUnifiedDiffSetSuccess | UnifiedDiffFailure;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/;
const DEV_NULL = "/dev/null";

function stripGitPrefix(path: string): string {
  return path.replace(/^([ab])\//, "");
}

function cleanHeaderPath(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  return stripGitPrefix(first);
}

function filePath(oldPath: string, newPath: string): string {
  return newPath === DEV_NULL ? oldPath : newPath;
}

function hunkLineCount(lines: readonly UnifiedDiffLine[], kind: "old" | "new"): number {
  return lines.reduce((count, line) => {
    if (line.kind === "context") return count + 1;
    if (kind === "old" && line.kind === "remove") return count + 1;
    if (kind === "new" && line.kind === "add") return count + 1;
    return count;
  }, 0);
}

function parseHunkHeader(line: string, lineNumber: number): MutableUnifiedDiffHunk | UnifiedDiffFailure {
  const match = HUNK_RE.exec(line);
  if (!match) return { ok: false, error: `invalid hunk header at diff line ${lineNumber}: ${line}` };
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5] || undefined,
    lines: [],
  };
}

function finalizeHunk(file: { hunks: UnifiedDiffHunk[] }, hunk: MutableUnifiedDiffHunk | undefined, lineNumber: number): UnifiedDiffFailure | undefined {
  if (!hunk) return undefined;
  const oldCount = hunkLineCount(hunk.lines, "old");
  const newCount = hunkLineCount(hunk.lines, "new");
  if (oldCount !== hunk.oldLines) return { ok: false, error: `hunk ending before diff line ${lineNumber} declares ${hunk.oldLines} old lines but has ${oldCount}` };
  if (newCount !== hunk.newLines) return { ok: false, error: `hunk ending before diff line ${lineNumber} declares ${hunk.newLines} new lines but has ${newCount}` };
  file.hunks.push(hunk);
  return undefined;
}

/** Parse a strict multi-file git/unified diff. */
export function parseUnifiedDiff(diff: string): ParseUnifiedDiffResult {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: Array<Omit<UnifiedDiffFile, "hunks"> & { hunks: UnifiedDiffHunk[] }> = [];
  let current: (Omit<UnifiedDiffFile, "hunks"> & { hunks: UnifiedDiffHunk[] }) | undefined;
  let hunk: MutableUnifiedDiffHunk | undefined;
  let sawFileHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    if (!line && i === lines.length - 1) break;

    if (hunk) {
      if (line.startsWith("diff --git ")) {
        if (!current) return { ok: false, error: `file header without current file at diff line ${lineNumber}` };
        const fail = finalizeHunk(current, hunk, lineNumber);
        if (fail) return fail;
        if (current.hunks.length === 0) return { ok: false, error: `file ${current.path} has no hunks` };
        current = undefined;
        hunk = undefined;
        sawFileHeader = true;
        continue;
      }
      if (line.startsWith("@@ ")) {
        if (!current) return { ok: false, error: `hunk before file header at diff line ${lineNumber}` };
        const fail = finalizeHunk(current, hunk, lineNumber);
        if (fail) return fail;
        const parsed = parseHunkHeader(line, lineNumber);
        if ("ok" in parsed) return parsed;
        hunk = parsed;
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) continue;
      const marker = line[0];
      if (marker === " ") hunk.lines.push({ kind: "context", text: line.slice(1) });
      else if (marker === "+") hunk.lines.push({ kind: "add", text: line.slice(1) });
      else if (marker === "-") hunk.lines.push({ kind: "remove", text: line.slice(1) });
      else return { ok: false, error: `invalid hunk line at diff line ${lineNumber}: ${line}` };
      continue;
    }

    if (line.startsWith("diff --git ")) {
      if (current) {
        if (current.hunks.length === 0) return { ok: false, error: `file ${current.path} has no hunks` };
      }
      current = undefined;
      sawFileHeader = true;
      continue;
    }

    if (line.startsWith("--- ")) {
      const next = lines[i + 1] ?? "";
      if (!next.startsWith("+++ ")) return { ok: false, error: `missing +++ header after diff line ${lineNumber}` };
      if (current) return { ok: false, error: `nested file header at diff line ${lineNumber}` };
      const oldPath = cleanHeaderPath(line.slice(4));
      const newPath = cleanHeaderPath(next.slice(4));
      if (!oldPath || !newPath) return { ok: false, error: `empty file path near diff line ${lineNumber}` };
      if (!sawFileHeader && oldPath === DEV_NULL) return { ok: false, error: `new-file diff near line ${lineNumber} must include diff --git header` };
      current = {
        oldPath,
        newPath,
        path: filePath(oldPath, newPath),
        hunks: [],
        isNewFile: oldPath === DEV_NULL,
        isDeletedFile: newPath === DEV_NULL,
      };
      files.push(current);
      i++;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) return { ok: false, error: `hunk before file header at diff line ${lineNumber}` };
      const parsed = parseHunkHeader(line, lineNumber);
      if ("ok" in parsed) return parsed;
      hunk = parsed;
      continue;
    }

    if (line.startsWith("index ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) continue;
    if (line.trim() === "") continue;
    return { ok: false, error: `unexpected diff content at line ${lineNumber}: ${line}` };
  }

  if (current) {
    const fail = finalizeHunk(current, hunk, lines.length);
    if (fail) return fail;
    if (current.hunks.length === 0) return { ok: false, error: `file ${current.path} has no hunks` };
  }
  if (files.length === 0) return { ok: false, error: "diff contains no file changes" };
  return { ok: true, files };
}

/** Apply one parsed file diff to an in-memory file body. */
export function applyUnifiedDiffToText(text: string, file: UnifiedDiffFile): ApplyUnifiedDiffResult {
  if (file.isNewFile && text.length > 0) return { ok: false, error: `new file '${file.path}' already has content` };
  const original = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cursor = 0;
  let applied = 0;

  for (const hunk of file.hunks) {
    const start = Math.max(hunk.oldStart - 1, 0);
    if (start < cursor) return { ok: false, error: `overlapping hunks in '${file.path}' around line ${hunk.oldStart}` };
    out.push(...original.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        out.push(line.text);
        applied++;
        continue;
      }
      const actual = original[cursor];
      if (actual !== line.text) {
        const expected = line.text.length === 0 ? "<blank>" : line.text;
        const found = actual === undefined ? "<eof>" : actual.length === 0 ? "<blank>" : actual;
        return { ok: false, error: `hunk mismatch in '${file.path}' at line ${cursor + 1}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)}` };
      }
      if (line.kind === "context") out.push(actual);
      if (line.kind === "remove") applied++;
      cursor++;
    }
  }

  out.push(...original.slice(cursor));
  return { ok: true, text: file.isDeletedFile ? "" : out.join("\n"), applied };
}

/** Parse and apply a unified diff to a set of file contents supplied by path. */
export function applyUnifiedDiffSet(diff: string, files: ReadonlyMap<string, string>): ApplyUnifiedDiffSetResult {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return parsed;
  const results: ApplyUnifiedDiffFileResult[] = [];
  for (const file of parsed.files) {
    const existing = file.isNewFile ? "" : files.get(file.path);
    if (existing === undefined) return { ok: false, error: `diff references missing file '${file.path}'` };
    const applied = applyUnifiedDiffToText(existing, file);
    if (!applied.ok) return applied;
    results.push({ path: file.path, text: applied.text, applied: applied.applied, deleted: file.isDeletedFile });
  }
  return { ok: true, files: results };
}

export function unifiedDiffPaths(diff: string): readonly string[] {
  const parsed = parseUnifiedDiff(diff);
  return parsed.ok ? parsed.files.map((file) => file.path) : [];
}
