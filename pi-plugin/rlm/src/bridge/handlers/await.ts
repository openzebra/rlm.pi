/**
 * await handler — collect results from background tasks.
 *
 * Supports single-task await (await_task(task_id="...")) and multi-task await
 * (await_task(task_ids=[...])). Returns AwaitResult with the collected result(s)
 * in input order for batches.
 */

import { errorMessage, formatError } from "../../util/errors.ts";
import type { AwaitResult, SubcallHandlerDeps, TaskEntry } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import type { AwaitDeps } from "./task-registry.ts";

export function createAwaitHandler(_deps: SubcallHandlerDeps, ad: AwaitDeps) {
  return async (
    taskId: string | undefined,
    taskIds: readonly string[] | undefined,
    timeoutS: number | undefined,
    _depth: number,
    _opts: SubcallOpts,
  ): Promise<AwaitResult> => {
    const timeoutMs = timeoutS !== undefined ? timeoutS * 1000 : undefined;

    // Single task
    if (taskId !== undefined && (taskIds === undefined || taskIds.length === 0)) {
      const entry = ad.get(taskId);
      if (entry === undefined) {
        return {
          ok: false,
          task_id: taskId,
          kind: "unknown",
          status: "error",
          error: `Task ${taskId} not found — was it already awaited or never spawned?`,
        };
      }

      if (entry.status === "pending") {
        try {
          const resolved = await ad.wait(taskId, timeoutMs);
          return toAwaitResult(resolved);
        } catch (err: unknown) {
          return {
            ok: false,
            task_id: taskId,
            kind: entry.kind,
            status: "error",
            error: formatError(errorMessage(err)),
          };
        }
      }

      return toAwaitResult(entry);
    }

    // Multiple tasks
    const ids = taskIds ?? (taskId !== undefined ? [taskId] : []);
    if (ids.length === 0) {
      return {
        ok: false,
        task_id: "",
        kind: "unknown",
        status: "error",
        error: "No task_id or task_ids provided to await",
      };
    }

    const entries = ids
      .map((id) => ad.get(id))
      .filter((e): e is TaskEntry => e !== undefined);

    if (entries.length === 0) {
      return {
        ok: false,
        task_id: ids[0] ?? "",
        kind: "unknown",
        status: "error",
        error: "None of the requested task IDs were found",
      };
    }

    const resolved = await Promise.all(
      entries.map(async (e) => {
        if (e.status === "pending") {
          try {
            return await ad.wait(e.taskId, timeoutMs);
          } catch {
            return e;
          }
        }
        return e;
      }),
    );

    const awaited = resolved.map(toAwaitResult);
    const allDone = awaited.every((a) => a.status === "done");
    const hasResults = awaited.some((a) => a.results !== undefined);
    const firstError = awaited.find((a) => a.error)?.error;
    const first = awaited[0];
    const kind = first?.kind ?? "unknown";

    if (hasResults) {
      const allResults: string[] = [];
      for (const a of awaited) {
        if (a.results !== undefined) {
          for (const r of a.results) allResults.push(r);
        } else if (a.result !== undefined) {
          allResults.push(a.result);
        }
      }
      return {
        ok: allDone,
        task_id: ids.join(","),
        kind,
        status: allDone ? "done" : "error",
        results: Object.freeze(allResults),
        error: firstError,
      };
    }

    if (awaited.length === 1 && first !== undefined) {
      return first;
    }

    return {
      ok: allDone,
      task_id: ids.join(","),
      kind,
      status: allDone ? "done" : "error",
      results: Object.freeze(awaited.map((a) => a.result ?? a.error ?? "")),
      error: firstError,
    };
  };
}

function toAwaitResult(entry: TaskEntry): AwaitResult {
  const status = entry.status === "pending" ? "error" : entry.status;
  return {
    ok: entry.status === "done",
    task_id: entry.taskId,
    kind: entry.kind,
    status,
    result: entry.result,
    results: entry.results,
    error:
      entry.error ??
      (entry.status === "pending" ? "Task still pending" : undefined),
  };
}
