/**
 * emitting() — the single emit-pattern helper for leaf sub-calls.
 *
 * AGENTS.md DRY #5: every leaf subcall follows create-node → execute → update.
 * rlm_query childRun emits its own node; do not wrap childRun in emitting.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { isErrorText } from "../../util/errors.ts";
import { previewText } from "../../text/preview.ts";
import type { Invocation } from "./types.ts";

export interface EmitOpts {
  readonly kind: "llm" | "batch";
  readonly label: string;
  readonly args: string;
  readonly model?: string;
}

export interface EmitSummary {
  readonly preview: string;
  readonly error?: string;
  readonly failed?: number;
  readonly total?: number;
}

/**
 * Create a subcall node, run `fn`, then update the node with status/cost/preview.
 * `fn` should not throw for soft failures (prefer Error: strings). Hard throws mark error.
 */
export async function emitting<T>(
  inv: Invocation,
  opts: EmitOpts,
  fn: (track: (usage: Usage) => void) => Promise<T>,
  summarize: (out: T) => EmitSummary,
): Promise<T> {
  const id = inv.emitter.emitSubcallCreated({
    kind: opts.kind,
    parentId: inv.parentId,
    label: opts.label,
    model: opts.model,
    args: opts.args,
    depth: inv.depth,
  });

  let costUsd = 0;
  let tokens = 0;
  const track = (u: Usage): void => {
    costUsd += u.cost.total;
    tokens += u.totalTokens;
  };

  try {
    const out = await fn(track);
    const summary = summarize(out);
    inv.emitter.emitSubcallUpdated({
      id,
      status: summary.error !== undefined ? "error" : "done",
      resultPreview: summary.preview,
      costUsd,
      tokens,
      detail: summary.error,
      failedCount: summary.failed,
      totalCount: summary.total,
    });
    return out;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    inv.emitter.emitSubcallUpdated({
      id,
      status: "error",
      resultPreview: msg,
      costUsd,
      tokens,
      detail: msg,
    });
    throw err;
  }
}

/** Summarize a batch result for the emitter. */
export function summarizeBatch(out: readonly string[]): EmitSummary {
  let failed = 0;
  let firstError: string | undefined;
  for (const s of out) {
    if (isErrorText(s)) {
      failed += 1;
      firstError ??= s;
    }
  }
  const first = previewText(out[0] ?? "");
  const error =
    failed === 0
      ? undefined
      : failed === out.length
        ? `all ${out.length} sub-calls failed — reduce batch size or try llm_query individually`
        : `${failed}/${out.length} sub-calls failed`;
  return {
    preview: out.length > 1 ? `${first}  (+${out.length - 1} more)` : first,
    error: error ?? firstError,
    failed,
    total: out.length,
  };
}
