import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import { err, formatError, ok, type Result } from "../util/errors.ts";
import { beginNativeEditInvocation } from "./native-edit-scope.ts";
import { callPiTool } from "./tool-invoker.ts";

export interface NativeEditReplacement {
  readonly oldText: string;
  readonly newText: string;
}

export interface NativeEditOperation {
  readonly path: string;
  readonly edits: readonly NativeEditReplacement[];
}

export interface NativeEditResult {
  readonly files: number;
  readonly edits: number;
}

export type NativeEditError =
  | { readonly kind: "empty-diff"; readonly message: string }
  | { readonly kind: "diff-too-large"; readonly message: string }
  | { readonly kind: "parse-failed"; readonly message: string }
  | { readonly kind: "unsupported-diff"; readonly message: string }
  | { readonly kind: "native-invoke-unavailable"; readonly message: string }
  | { readonly kind: "native-invoke-failed"; readonly message: string };

interface NativeEditToolArgs {
  readonly path: string;
  readonly edits: readonly NativeEditReplacement[];
}

const EDIT_TOOL_NAME = "edit";
const DEV_NULL = "/dev/null";
const MAX_NATIVE_DIFF_CHARS = 250_000;

function normalizePatchPath(oldFileName: string | undefined, newFileName: string | undefined): Result<string, NativeEditError> {
  if (oldFileName === DEV_NULL || newFileName === DEV_NULL) {
    return err({ kind: "unsupported-diff", message: "native edit does not support file create/delete diffs yet" });
  }
  const raw = newFileName ?? oldFileName;
  if (!raw?.trim()) {
    return err({ kind: "unsupported-diff", message: "diff file header does not include a target path" });
  }
  const path = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return path.trim()
    ? ok(path)
    : err({ kind: "unsupported-diff", message: "diff target path is empty" });
}

function lineDelimitersOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const delimiters = (value as { readonly linedelimiters?: unknown }).linedelimiters;
  return Array.isArray(delimiters) && delimiters.every((item) => typeof item === "string") ? delimiters : undefined;
}

function hunkToReplacement(
  lines: readonly string[],
  delimiters: readonly string[] | undefined,
): Result<NativeEditReplacement, NativeEditError> {
  const oldParts = new Array<string>(lines.length);
  const newParts = new Array<string>(lines.length);
  let oldCount = 0;
  let newCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.startsWith("\\")) continue;
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    const delimiter = delimiters?.[i] ?? "\n";
    if (marker === " " || marker === "-") {
      oldParts[oldCount] = `${text}${delimiter}`;
      oldCount++;
    }
    if (marker === " " || marker === "+") {
      newParts[newCount] = `${text}${delimiter}`;
      newCount++;
    }
    if (marker !== " " && marker !== "-" && marker !== "+") {
      return err({ kind: "unsupported-diff", message: `unsupported diff hunk line marker '${marker}'` });
    }
  }

  const oldText = oldParts.slice(0, oldCount).join("");
  if (!oldText) {
    return err({ kind: "unsupported-diff", message: "native edit requires non-empty oldText anchors" });
  }
  return ok({ oldText, newText: newParts.slice(0, newCount).join("") });
}

export function diffToNativeEditOperations(diff: string): Result<readonly NativeEditOperation[], NativeEditError> {
  const trimmed = diff.trim();
  if (!trimmed) return err({ kind: "empty-diff", message: "propose_diff requires a non-empty unified diff" });
  if (trimmed.length > MAX_NATIVE_DIFF_CHARS) {
    return err({
      kind: "diff-too-large",
      message: `diff is too large for synchronous native edit conversion (${trimmed.length.toLocaleString()} chars > ${MAX_NATIVE_DIFF_CHARS.toLocaleString()} chars); split it by file or hunk`,
    });
  }

  let patches: ReturnType<typeof Diff.parsePatch>;
  try {
    patches = Diff.parsePatch(trimmed);
  } catch (e) {
    return err({ kind: "parse-failed", message: e instanceof Error ? e.message : String(e) });
  }
  if (patches.length === 0) return err({ kind: "parse-failed", message: "no file patches found in unified diff" });

  const operations = new Array<NativeEditOperation>(patches.length);
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (!patch) return err({ kind: "parse-failed", message: "malformed parsed patch" });
    const pathResult = normalizePatchPath(patch.oldFileName, patch.newFileName);
    if (!pathResult.ok) return pathResult;
    if (patch.hunks.length === 0) {
      return err({ kind: "parse-failed", message: `diff for ${pathResult.value} has no hunks` });
    }

    const edits = new Array<NativeEditReplacement>(patch.hunks.length);
    for (let j = 0; j < patch.hunks.length; j++) {
      const hunk = patch.hunks[j];
      if (!hunk) return err({ kind: "parse-failed", message: `malformed hunk in ${pathResult.value}` });
      const edit = hunkToReplacement(hunk.lines, lineDelimitersOf(hunk));
      if (!edit.ok) return edit;
      edits[j] = edit.value;
    }
    operations[i] = { path: pathResult.value, edits };
  }
  return ok(operations);
}

export async function invokeNativeEditsFromDiff(
  ctx: ExtensionContext,
  diff: string,
): Promise<Result<NativeEditResult, NativeEditError>> {
  const operations = diffToNativeEditOperations(diff);
  if (!operations.ok) return operations;

  let editCount = 0;
  for (const operation of operations.value) editCount += operation.edits.length;

  for (const operation of operations.value) {
    const args: NativeEditToolArgs = { path: operation.path, edits: operation.edits };
    const endNativeEditInvocation = beginNativeEditInvocation();
    try {
      const result = await callPiTool(ctx, EDIT_TOOL_NAME, args);
      if (!result.ok) {
        const kind = result.error.kind === "tool-invoke-unavailable" ? "native-invoke-unavailable" : "native-invoke-failed";
        return err({ kind, message: result.error.message });
      }
    } finally {
      endNativeEditInvocation();
    }
  }

  return ok({ files: operations.value.length, edits: editCount });
}

export function createNativeProposeDiffHandler(ctx: ExtensionContext): (diff: string, depth: number) => Promise<string> {
  return async (diff: string, depth: number): Promise<string> => {
    if (depth > 0) return formatError("propose_diff is only available at the root RLM depth");
    const result = await invokeNativeEditsFromDiff(ctx, diff);
    if (!result.ok) return formatError(result.error.message);
    return `Native edit proposed ${result.value.edits} edit${result.value.edits === 1 ? "" : "s"} across ${result.value.files} file${result.value.files === 1 ? "" : "s"}.`;
  };
}
