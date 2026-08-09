/**
 * finish handler — contract boundary: the model signals completion.
 *
 * Soft policy (default): returns finished=true always. If tasks are still pending,
 * includes `warning` listing unawaited task_ids — does **not** auto-drain results
 * into the summary (that would hide model mistakes). Callers may refuse to stop
 * when warning is set.
 */

import type { FinishResult, SubcallHandlerDeps } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import type { AwaitDeps } from "./task-registry.ts";

export function createFinishHandler(
  deps: SubcallHandlerDeps,
  ad?: AwaitDeps,
) {
  return async (
    summary: string,
    depth: number,
    opts: SubcallOpts,
  ): Promise<FinishResult & { readonly summary?: string; readonly warning?: string }> => {
    const inv = deps.resolve(opts, depth);
    const pending = ad?.unawaitedIds() ?? [];
    const warning =
      pending.length > 0
        ? `finish called with unawaited tasks: ${pending.join(", ")}`
        : undefined;

    if (inv !== null) {
      inv.emitter.emitSubcallUpdated?.({
        id: inv.parentId ?? "root",
        status: "done",
        detail: warning ?? "finish called",
      });
    }

    return {
      ok: true,
      finished: true,
      summary: summary.length > 0 ? summary : undefined,
      warning,
    };
  };
}
