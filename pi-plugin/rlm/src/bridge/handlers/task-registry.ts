/**
 * Single in-memory task registry for api_v5 async-by-default spawns.
 *
 * DRY: this is the ONLY place that assigns task_ids, parks await waiters, and
 * resolves/rejects entries. Handlers and session UI both consume this type —
 * never re-implement a Map of TaskEntry elsewhere.
 */

import type { AwaitResult, SpawnResult, TaskEntry } from "./types.ts";
import { formatError, isErrorText } from "../../util/errors.ts";

export const SPAWN_HINT =
  "Call await_task(task_id=...) to get the result — this is NOT the answer.";

export interface SpawnDeps {
  nextId(): number;
  register(kind: SpawnResult["kind"], n: number, taskId: string): SpawnResult;
  resolve(taskId: string, result: string | readonly string[]): void;
  reject(taskId: string, error: string): void;
}

export interface AwaitDeps {
  get(taskId: string): TaskEntry | undefined;
  wait(taskId: string, timeoutMs?: number): Promise<TaskEntry>;
  unawaitedIds(): readonly string[];
}

/** DRY: the ONE TaskEntry → AwaitResult mapping — shared by the await handler and the registry. */
export function entryToAwaitResult(entry: TaskEntry): AwaitResult {
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

export interface TaskRegistry {
  readonly spawnDeps: SpawnDeps;
  readonly awaitDeps: AwaitDeps;
  entries(): ReadonlyMap<string, TaskEntry>;
  toAwaitResult(taskId: string): AwaitResult;
}

interface Waiter {
  readonly resolve: (entry: TaskEntry) => void;
  readonly reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function notify(waiters: Map<string, Waiter[]>, taskId: string, entry: TaskEntry): void {
  const list = waiters.get(taskId);
  if (list === undefined) return;
  waiters.delete(taskId);
  for (const w of list) {
    if (w.timer !== undefined) clearTimeout(w.timer);
    w.resolve(entry);
  }
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskEntry>();
  const waiters = new Map<string, Waiter[]>();
  let counter = 0;

  const spawnDeps: SpawnDeps = {
    nextId: () => {
      counter += 1;
      return counter;
    },
    register(kind, n, taskId) {
      const entry: TaskEntry = {
        taskId,
        kind,
        n,
        status: "pending",
        createdAt: Date.now(),
      };
      tasks.set(taskId, entry);
      return Object.freeze({
        ok: true,
        task_id: taskId,
        kind,
        n,
        status: "pending" as const,
        hint: SPAWN_HINT,
      });
    },
    resolve(taskId, result) {
      const entry = tasks.get(taskId);
      // Settle-once: a late resolve after a timeout/reject must not flip status or
      // double-notify; the entry is terminal the moment it leaves "pending".
      if (entry === undefined || entry.status !== "pending") return;
      entry.status = "done";
      if (typeof result === "string") {
        entry.result = result;
      } else {
        entry.results = Object.freeze([...result]);
      }
      notify(waiters, taskId, entry);
    },
    reject(taskId, error) {
      const entry = tasks.get(taskId);
      // Settle-once (mirror of resolve): reject after resolve/timeout is a no-op.
      if (entry === undefined || entry.status !== "pending") return;
      entry.status = "error";
      entry.error = error;
      const list = waiters.get(taskId);
      if (list !== undefined) {
        waiters.delete(taskId);
        for (const w of list) {
          if (w.timer !== undefined) clearTimeout(w.timer);
          w.reject(new Error(error));
        }
      }
    },
  };

  const awaitDeps: AwaitDeps = {
    get: (taskId) => tasks.get(taskId),
    wait(taskId, timeoutMs) {
      return new Promise<TaskEntry>((resolve, reject) => {
        const entry = tasks.get(taskId);
        if (entry !== undefined && entry.status !== "pending") {
          resolve(entry);
          return;
        }
        const w: Waiter = { resolve, reject };
        w.timer =
          timeoutMs !== undefined
            ? setTimeout(() => {
                w.timer = undefined;
                // Remove only THIS waiter — a sibling wait() on the same task stays parked.
                const list = waiters.get(taskId);
                let lastWaiter = true;
                if (list !== undefined) {
                  const i = list.indexOf(w);
                  if (i >= 0) {
                    list.splice(i, 1);
                    lastWaiter = list.length === 0;
                    if (lastWaiter) waiters.delete(taskId);
                  }
                }
                // Timeout is a per-waiter event, not a task property: only when the LAST
                // waiter gives up does the shared entry record "timeout" (settle-once then
                // keeps a late resolve from resurrecting it). While a sibling stays parked,
                // the entry remains pending and resolve() still wakes it.
                if (lastWaiter) {
                  const e = tasks.get(taskId);
                  if (e !== undefined && e.status === "pending") {
                    e.status = "timeout";
                    e.error = `Timeout after ${timeoutMs}ms`;
                  }
                }
                reject(new Error(`Timeout waiting for task ${taskId}`));
              }, timeoutMs)
            : undefined;
        const list = waiters.get(taskId);
        if (list === undefined) waiters.set(taskId, [w]);
        else list.push(w);
      });
    },
    unawaitedIds: () => {
      const ids: string[] = [];
      for (const [id, e] of tasks) {
        if (e.status === "pending") ids.push(id);
      }
      return ids;
    },
  };

  return {
    spawnDeps,
    awaitDeps,
    entries: () => tasks,
    toAwaitResult(taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) {
        return {
          ok: false,
          task_id: taskId,
          kind: "unknown",
          status: "error",
          error: `Task ${taskId} not found`,
        };
      }
      return entryToAwaitResult(entry);
    },
  };
}

/**
 * Register a spawn and start background work once.
 * Returns SpawnResult immediately; never uses non-null assertions on task_id.
 */
export function spawnAndRun(
  sd: SpawnDeps,
  kind: SpawnResult["kind"],
  n: number,
  work: () => Promise<string | readonly string[]>,
  trackDetached: (<T>(run: () => Promise<T>) => Promise<T>) | undefined,
  detached: boolean,
): SpawnResult {
  const id = sd.nextId();
  const taskId = `task_${id}`;
  const spawned = sd.register(kind, n, taskId);

  const run = async (): Promise<void> => {
    try {
      const result = await work();
      sd.resolve(taskId, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sd.reject(taskId, isErrorText(message) ? message : formatError(message));
    }
  };

  if (trackDetached !== undefined && detached) {
    void trackDetached(run).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sd.reject(taskId, isErrorText(message) ? message : formatError(message));
    });
  } else {
    void run();
  }

  return spawned;
}
