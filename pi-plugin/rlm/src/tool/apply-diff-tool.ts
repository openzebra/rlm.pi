/**
 * `apply_diff` — the main-agent-facing editing tool.
 *
 * Lightweight by design: the root model produces a complete unified diff
 * directly and this tool validates its header then writes to disk via `applyEdits()`.
 * Unlike the old `propose_edits`,
 * there is NO inner RLM engine turn (no generate→validate→revise loop) — the
 * model is trusted to emit a correct diff.
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyEdits } from "../patch/index.ts";
import { validateToolParams } from "./tool-utils.ts";
import { errorMessage } from "../util/errors.ts";
import { headlineStatusGlyph } from "./subcall-render.ts";
import type { ProposedDiffEdit } from "../sandbox/protocol.ts";

// ── Parameter schema ──────────────────────────────────────────────────────

const ApplyDiffParams = Object.freeze(Type.Object({
  diff: Type.String({
    description: "Full unified diff string. Must include --- a/<path> / +++ b/<path> header and @@ hunk markers.",
  }),
}));

// ── Details (no inner engine → no sub-call tree) ──────────────────────────

export interface ApplyDiffDetails {
  readonly status: "done" | "error";
  readonly path: string;
}

const errorDetails = (): ApplyDiffDetails => ({ status: "error", path: "" });

// ── Helpers ───────────────────────────────────────────────────────────────

/** True when the diff carries a real `--- a/<path>` header (not a bare `---`). */
function hasValidHeader(diff: string): boolean {
  return /^--- \S/m.test(diff);
}

/** Extract the first target file path from a `--- a/<path>` header line. */
function firstDiffPath(diff: string): string {
  const match = /^--- a\/(.+)$/m.exec(diff);
  return match?.[1] ?? "(unknown path)";
}

/** First ~60 chars of the diff body, starting at the first hunk marker. */
function bodyPreview(diff: string): string {
  const start = diff.indexOf("@@");
  const body = start >= 0 ? diff.slice(start) : diff;
  return body.replace(/\n/g, " ").slice(0, 60);
}

// ── Tool factory ──────────────────────────────────────────────────────────

export function createApplyDiffTool(): ToolDefinition<typeof ApplyDiffParams, ApplyDiffDetails> {
  return {
    name: "apply_diff",
    label: "Apply Diff",
    description: [
      "Apply a complete unified diff directly to disk.",
      "The diff MUST include a --- a/<path> / +++ b/<path> header and @@ hunk markers.",
         ].join(" "),
    parameters: ApplyDiffParams,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const validation = validateToolParams(ApplyDiffParams, rawParams, "apply_diff", errorDetails);
      if (!validation.ok) return validation.error;
      const { diff } = validation.value;

      if (!diff.trim()) {
        return {
          content: [{ type: "text", text: "apply_diff requires a non-empty diff." }],
          details: errorDetails(),
        };
      }

      // No `path` param → the model MUST include a complete header. Reject with a
      // clear message instead of a silent fallback so a malformed diff is surfaced.
      if (!hasValidHeader(diff)) {
        return {
          content: [{
            type: "text",
            text: "apply_diff requires a complete unified diff with --- a/<path> / +++ b/<path> header and @@ hunk markers.",
          }],
          details: errorDetails(),
        };
      }

      const path = firstDiffPath(diff);
      const diffEdit: ProposedDiffEdit = { diff };
      try {
        await applyEdits([], [diffEdit], ctx);
      } catch (e) {
        return {
          content: [{ type: "text", text: `apply_diff failed: ${errorMessage(e)}` }],
          details: { status: "error", path },
        };
      }

      return {
        content: [{ type: "text", text: `Applied diff to ${path}.` }],
        details: { status: "done", path },
      };
    },

    renderCall(args, theme) {
      const path = firstDiffPath(args.diff);
      return new Text(
        [theme.fg("toolTitle", theme.bold("apply_diff ")), theme.fg("dim", `${path}: ${bodyPreview(args.diff)}`)].join(""),
        0, 0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as ApplyDiffDetails | undefined;
      const path = details?.path ? details.path : "(unknown path)";
      const glyph = headlineStatusGlyph(details?.status === "error" ? "error" : "done", theme);
      return new Text(`${glyph} ${theme.fg("toolTitle", theme.bold("apply_diff"))} · ${path}`, 0, 0);
    },
  };
}
