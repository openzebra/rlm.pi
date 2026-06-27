import { formatError } from "../util/errors.ts";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface Task {
  readonly id: number;
  readonly subject: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly activeForm?: string;
  readonly blockedBy?: readonly number[];
  readonly owner?: string;
}

interface TodoParams {
  readonly id?: number;
  readonly subject?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly activeForm?: string;
  readonly blockedBy?: readonly number[];
  readonly addBlockedBy?: readonly number[];
  readonly removeBlockedBy?: readonly number[];
  readonly owner?: string;
  readonly filterStatus?: string;
  readonly includeDeleted?: boolean;
}

const TODO_STATUSES = Object.freeze(new Set<unknown>(["pending", "in_progress", "completed", "deleted"]));

function isTaskStatus(value: unknown): value is TaskStatus {
  return TODO_STATUSES.has(value);
}

function numericArray(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) ? Object.freeze(value.filter((n): n is number => typeof n === "number")) : undefined;
}

function toTodoParams(raw: Record<string, unknown>): TodoParams {
  const blockedBy = numericArray(raw.blockedBy);
  const addBlockedBy = numericArray(raw.addBlockedBy);
  const removeBlockedBy = numericArray(raw.removeBlockedBy);
  return Object.freeze({
    ...(typeof raw.id === "number" ? { id: raw.id } : {}),
    ...(typeof raw.subject === "string" ? { subject: raw.subject } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(isTaskStatus(raw.status) ? { status: raw.status } : {}),
    ...(typeof raw.activeForm === "string" ? { activeForm: raw.activeForm } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    ...(addBlockedBy ? { addBlockedBy } : {}),
    ...(removeBlockedBy ? { removeBlockedBy } : {}),
    ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
    ...(typeof raw.filterStatus === "string" ? { filterStatus: raw.filterStatus } : {}),
    ...(raw.includeDeleted === true ? { includeDeleted: true } : {}),
  });
}

function patchedBlockedBy(task: Task, params: TodoParams): readonly number[] | undefined {
  if (params.blockedBy) return params.blockedBy;

  let next = task.blockedBy ?? Object.freeze([] as readonly number[]);
  if (params.addBlockedBy) next = Object.freeze([...next, ...params.addBlockedBy]);

  if (params.removeBlockedBy) {
    const removeSet = new Set(params.removeBlockedBy);
    next = Object.freeze(next.filter((n) => !removeSet.has(n)));
  }
  return next.length ? next : undefined;
}

function taskLines(task: Task): readonly string[] {
  const lines: string[] = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((n) => `#${n}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines;
}

function withPatch(task: Task, params: TodoParams): Task {
  const blockedBy = patchedBlockedBy(task, params);
  return Object.freeze({
    ...task,
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    ...(params.owner !== undefined ? { owner: params.owner } : {}),
  });
}

export function createTodoFallback(): (action: string, params: Record<string, unknown>) => Promise<string> {
  let nextId = 1;
  let tasks: readonly Task[] = Object.freeze([]);
  const fmt = (task: Task): string => taskLines(task)[0] ?? `#${task.id}`;

  const apply = (action: string, rawParams: Record<string, unknown>): string => {
    const params = toTodoParams(rawParams);
    if (action === "clear") {
      const count = tasks.length;
      tasks = Object.freeze([]);
      nextId = 1;
      return `Cleared ${count} task(s).`;
    }
    if (action === "create") {
      const subject = typeof params.subject === "string" && params.subject.trim() ? params.subject.trim() : undefined;
      if (!subject) return formatError("create requires subject");
      const task = withPatch(Object.freeze({ id: nextId, subject, status: "pending" }), params);
      nextId += 1;
      tasks = Object.freeze([...tasks, task]);
      return `Created ${fmt(task)}`;
    }
    if (action === "list") {
      const filter = params.filterStatus ?? params.status;
      const includeDeleted = params.includeDeleted === true;
      const rows = tasks.filter((task) => (includeDeleted || task.status !== "deleted") && (!filter || task.status === filter)).map(fmt);
      return rows.length ? rows.join("\n") : "No tasks.";
    }
    const id = params.id;
    const task = id !== undefined ? tasks.find((item) => item.id === id) : undefined;
    if (!task) return formatError(`task #${id ?? "?"} not found`);
    if (action === "get") return taskLines(task).join("\n");
    if (action === "delete") {
      const deleted = Object.freeze({ ...task, status: "deleted" as const });
      tasks = Object.freeze(tasks.map((item) => item.id === task.id ? deleted : item));
      return `Deleted ${fmt(deleted)}`;
    }
    if (action === "update") {
      const updated = withPatch(task, params);
      tasks = Object.freeze(tasks.map((item) => item.id === task.id ? updated : item));
      return `Updated ${fmt(updated)}`;
    }
    return formatError(`unknown todo action '${action}'`);
  };
  return async (action, params) => apply(action, params);
}
