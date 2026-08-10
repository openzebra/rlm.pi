/**
 * createSubcallHandlers — assembles the complete async-by-default handler set.
 *
 * This is the ONE place where subcall handlers are wired together. The engine
 * and repl() tool both call this with their own resolve + trackDetached.
 *
 * Task identity lives in TaskRegistry (one implementation). Pass an optional
 * registry to share session state; otherwise a fresh registry is created.
 */

import { createLlmQueryHandler, createLlmBatchHandler } from "./llm-query.ts";
import { createRlmQueryHandler, createRlmBatchHandler } from "./rlm-query.ts";
import { createAwaitHandler } from "./await.ts";
import { createFinishHandler } from "./finish.ts";
import { createTaskRegistry, type TaskRegistry } from "./task-registry.ts";
import type { SubcallHandlerDeps, SubcallHandlers } from "./types.ts";

export function createSubcallHandlers(
  deps: SubcallHandlerDeps,
  registry: TaskRegistry = createTaskRegistry(),
): SubcallHandlers {
  // Do NOT call getLlmModel() here — recursion-only tests leave leaf models unwired
  // and throw if resolved at construction. complete1 reads getLlmModel lazily per call.
  return {
    llmQuery: createLlmQueryHandler(deps, registry.spawnDeps),
    llmBatch: createLlmBatchHandler(deps, registry.spawnDeps),
    rlmQuery: createRlmQueryHandler(deps, registry.spawnDeps),
    rlmBatch: createRlmBatchHandler(deps, registry.spawnDeps),
    awaitTask: createAwaitHandler(deps, registry.awaitDeps),
    finishTask: createFinishHandler(deps, registry.awaitDeps),
  };
}

export type {
  SubcallHandlerDeps,
  SubcallHandlers,
  SpawnResult,
  AwaitResult,
  FinishResult,
  Invocation,
  InvocationLimits,
  SubcallConfig,
} from "./types.ts";

export { limitsFromRemaining } from "./types.ts";
export { summarizeBatch } from "./emitting.ts";
export { createTaskRegistry, SPAWN_HINT } from "./task-registry.ts";
export type { TaskRegistry, SpawnDeps, AwaitDeps } from "./task-registry.ts";
