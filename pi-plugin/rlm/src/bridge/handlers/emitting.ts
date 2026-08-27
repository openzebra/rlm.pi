/**
 * emitting() — the single emit-pattern helper for leaf sub-calls.
 *
 * AGENTS.md DRY #5: every leaf subcall follows create-node → execute → update.
 * rlm_query childRun emits its own node; do not wrap childRun in emitting.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { isErrorText } from "../../util/errors.ts";
import { previewText } from "../../text/preview.ts";
import type { SubcallPhase } from "../../tool/rlm-details.ts";
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

/** Targeted update for THIS node — the 2nd arg every `fn` handed to emitting() receives. */
export type EmitNote = (u: { readonly phase?: SubcallPhase; readonly detail?: string }) => void;

/**
 * Create a subcall node, run `fn`, then update the node with status/cost/preview.
 * `fn` should not throw for soft failures (prefer Error: strings). Hard throws mark error.
 * The `note` arg lets `fn` surface live per-node state — e.g. parking on the rate-limit
 * cooldown (throttleHooks below).
 */
export async function emitting<T>(
  inv: Invocation,
  opts: EmitOpts,
  fn: (track: (usage: Usage) => void, note: EmitNote) => Promise<T>,
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
  // Leaf nodes spend their whole lifetime waiting on the model — say so from birth.
  inv.emitter.emitSubcallUpdated({ id, phase: "waiting" });
  const note: EmitNote = (u): void => {
    inv.emitter.emitSubcallUpdated({ id, ...u });
  };

  let costUsd = 0;
  let tokens = 0;
  const track = (u: Usage): void => {
    costUsd += u.cost.total;
    tokens += u.totalTokens;
  };

  try {
    const out = await fn(track, note);
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

/** Summarize a single leaf answer for the emitter — shared by llm_query and every llm_batch item. */
export function summarizeLeaf(out: string): EmitSummary {
  return { preview: previewText(out), error: isErrorText(out) ? out : undefined };
}

/**
 * Wire a leaf's `note` into modelComplete's throttle callbacks: parked → "queued" with the
 * pending seconds in detail; released → back to plain "waiting". One helper so every leaf
 * call site reports the queue state identically.
 */
export function throttleHooks(note: EmitNote): {
  readonly onThrottlePark: (ms: number) => void;
  readonly onThrottleRelease: () => void;
} {
  return {
    onThrottlePark: (ms): void => {
      note({ phase: "queued", detail: `rate limit — waiting ${Math.max(1, Math.round(ms / 1000))}s` });
    },
    onThrottleRelease: (): void => {
      note({ phase: "waiting" });
    },
  };
}
