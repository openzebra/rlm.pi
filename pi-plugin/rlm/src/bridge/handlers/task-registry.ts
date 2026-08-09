/**
 * Single in-memory task registry for api_v5 async-by-default spawns.
 *
 * DRY: this is the ONLY place that assigns task_ids, parks await waiters, and
 * resolves/rejects entries. Handlers and session UI both consume this type —
 * never re-implement a Map of TaskEntry elsewhere.
 */

import type { AwaitResult, SpawnResult, TaskEntry } from "./types.ts";

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

export interface TaskRegistry {
  readonly spawnDeps: SpawnDeps;
  readonly awaitDeps: AwaitDeps;
  entries(): ReadonlyMap<string, TaskEntry>;
  toAwaitResult(taskId: string): AwaitResult;
}

interface Waiter {
  resolve: (entry: TaskEntry) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function notify(waiters: Map<string, Waiter>, taskId: string, entry: TaskEntry): void {
  const w = waiters.get(taskId);
  if (w === undefined) return;
  if (w.timer !== undefined) clearTimeout(w.timer);
  w.resolve(entry);
  waiters.delete(taskId);
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, TaskEntry>();
  const waiters = new Map<string, Waiter>();
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
      if (entry === undefined) return;
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
      if (entry === undefined) return;
      entry.status = "error";
      entry.error = error;
      const w = waiters.get(taskId);
      if (w !== undefined) {
        if (w.timer !== undefined) clearTimeout(w.timer);
        w.reject(new Error(error));
        waiters.delete(taskId);
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
        const timer =
          timeoutMs !== undefined
            ? setTimeout(() => {
                waiters.delete(taskId);
                const e = tasks.get(taskId);
                if (e !== undefined && e.status === "pending") {
                  e.status = "timeout";
                  e.error = `Timeout after ${timeoutMs}ms`;
                }
                reject(new Error(`Timeout waiting for task ${taskId}`));
              }, timeoutMs)
            : undefined;
        waiters.set(taskId, { resolve, reject, timer });
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
      const status =
        entry.status === "pending" ? "error" : entry.status;
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
      sd.reject(taskId, message.startsWith("Error:") ? message : `Error: ${message}`);
    }
  };

  if (trackDetached !== undefined && detached) {
    void trackDetached(run).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sd.reject(taskId, message.startsWith("Error:") ? message : `Error: ${message}`);
    });
  } else {
    void run();
  }

  return spawned;
}
