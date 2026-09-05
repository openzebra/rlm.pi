/**
 * rlm_query and rlm_batch handlers — async-by-default spawn pattern.
 *
 * AGENTS.md DRY #2: childRun exists once, here.
 */

import { modelLabelOf } from "../../config/settings.ts";
import { errorMessage, formatError } from "../../util/errors.ts";
import { filterContextByPaths } from "../../context/merge.ts";
import { previewText } from "../../text/preview.ts";
import type { RlmInput, RlmResult } from "../../core/types.ts";
import { checkResourceLimits } from "../../core/resource-limits.ts";
import { contextSig, ECHO_STUB, taskKey } from "../../core/ledger.ts";
import type { Invocation, SpawnResult, SubcallHandlerDeps } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import { spawnAndRun, type SpawnDeps } from "./task-registry.ts";
import { complete1, completeDeps } from "./completion.ts";
import { emitting, summarizeLeaf, throttleHooks } from "./emitting.ts";
import { activeLedger, leafClaimKey, runClaimedLeaf, unwiredSpawn } from "./llm-query.ts";

const NO_UNMATCHED: readonly string[] = Object.freeze([]);

function emptyResult(answer: string): RlmResult {
  return {
    answer,
    iterations: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };
}

interface ChildContext {
  readonly context: unknown;
  readonly unmatched: readonly string[];
}

function childContextFor(
  deps: SubcallHandlerDeps,
  prompt: string,
  paths: readonly string[] | undefined,
): ChildContext {
  const inherited = deps.getChildContext?.();
  if (inherited === undefined || inherited === null) {
    return Object.freeze({ context: prompt, unmatched: NO_UNMATCHED });
  }
  if (paths === undefined || paths.length === 0) {
    return Object.freeze({ context: inherited, unmatched: NO_UNMATCHED });
  }
  const filtered = filterContextByPaths(inherited, paths);
  return Object.freeze({
    context: filtered.files.length > 0 ? filtered.files : inherited,
    unmatched: filtered.unmatched,
  });
}

function claimKeyFor(deps: SubcallHandlerDeps, kind: "llm" | "rlm", prompt: string, paths: readonly string[], ctx: string): string {
  const rootModel = deps.getModel?.();
  const modelId = rootModel === undefined ? "" : modelLabelOf(rootModel);
  return taskKey(kind, prompt, paths, modelId, ctx);
}

/**
 * One child RLM run: depth cap → resource guard → ledger gate → depth gate → spawn engine →
 * debit parent. Emits its own subcall node (do not wrap in emitting()).
 */
async function childRun(
  deps: SubcallHandlerDeps,
  inv: Invocation,
  prompt: string,
  paths: readonly string[] | undefined,
): Promise<RlmResult> {
  const childDepth = inv.depth + 1;
  const run = deps.runChild;
  const maxDepth = deps.getConfig().maxDepth;

  if (run === undefined || childDepth >= maxDepth) {
    const degrade = deps.degrade;
    const answer =
      degrade !== undefined
        ? await degrade(prompt, inv.depth)
        : await complete1(inv, prompt, () => {}, completeDeps(deps));
    return emptyResult(answer);
  }

  const remTimeout = inv.limits.remainingTimeoutMs();
  const limitError = checkResourceLimits({ timeoutMs: remTimeout });
  if (limitError !== undefined) return emptyResult(limitError);

  const child = childContextFor(deps, prompt, paths);
  const rootPrompt =
    child.unmatched.length === 0
      ? prompt
      : `${prompt}\n\n[rlm] paths=${child.unmatched.join(", ")} matched no files; you received the full context.`;

  const sig = contextSig(child.context);
  const key = claimKeyFor(deps, "rlm", prompt, paths ?? [], sig);

  // ── v5 TaskLedger: echo → stub; duplicate → coalesce onto the existing runner ──────
  const ledger = activeLedger(deps);
  const claimKey = ledger === undefined ? undefined : key;
  const decision =
    ledger !== undefined && claimKey !== undefined
      ? ledger.tryClaim({ kind: "rlm", prompt, paths: paths ?? [], depth: childDepth }, claimKey)
      : undefined;

  // ONE subcall node per childRun (audit C2 / DRY #5): the decision branch reuses it, the
  // run branch reports the engine's turns/cost on it. Never a second emit below.
  const rootModel = deps.getModel?.();
  const modelLabel = rootModel === undefined ? undefined : modelLabelOf(rootModel);
  const subId = inv.emitter.emitSubcallCreated({
    kind: "rlm",
    parentId: inv.parentId,
    label: decision === undefined || decision.type === "run" ? "rlm_query" : `rlm_query (${decision.type})`,
    model: modelLabel,
    detail: prompt.slice(0, 60),
    depth: childDepth,
  });
  inv.emitter.emitSubcallUpdated({ id: subId, phase: "spawning" });

  if (decision?.type === "echo") {
    inv.emitter.emitSubcallUpdated({ id: subId, status: "done", resultPreview: ECHO_STUB.slice(0, 80) });
    return emptyResult(ECHO_STUB);
  }
  if (decision?.type === "coalesce" && ledger !== undefined) {
    const twin = await ledger
      .waitFor(decision.key)
      .catch((err: unknown) => errorMessage(err));
    inv.emitter.emitSubcallUpdated({ id: subId, status: "done", resultPreview: previewText(twin.slice(0, 80)) });
    return emptyResult(twin);
  }
  if (ledger !== undefined && claimKey !== undefined) {
    ledger.markRunning(claimKey);
  }

  const input: RlmInput = {
    rootPrompt,
    context: child.context,
    depth: childDepth,
    parentNodeId: subId,
    remainingTimeoutMs: remTimeout,
    ledger, // DRY #6: the one seam — children share the parent's blackboard
  };

  try {
    const res = await deps.gates.rlm.at(childDepth).run(() => run(input, inv));
    inv.limits.addRaw(res.costUsd, res.inputTokens, res.outputTokens);
    deps.onChildUsage?.(res.costUsd, res.inputTokens, res.outputTokens);
    if (ledger !== undefined && claimKey !== undefined) ledger.finish(claimKey, res.answer);
    inv.emitter.emitSubcallUpdated({
      id: subId,
      status: "done",
      resultPreview: res.answer.slice(0, 200),
      tokensIn: res.inputTokens,
      tokensOut: res.outputTokens,
    });
    return res;
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (ledger !== undefined && claimKey !== undefined) ledger.fail(claimKey, msg);
    inv.emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
    return emptyResult(formatError(`child RLM failed - ${msg}`));
  }
}

export function createRlmQueryHandler(deps: SubcallHandlerDeps, sd: SpawnDeps) {
  return async (
    task: string,
    depth: number,
    opts: SubcallOpts,
  ): Promise<SpawnResult> => {
    const inv = deps.resolve(opts, depth);
    if (inv === null) return unwiredSpawn("rlm", 1);

    const pathArg = opts.paths;

    // v5 rlmBudget demotion: once the ledger has started `rlmBudget` real rlm runs, extra
    // rlm_query spawns demote to the leaf path (batch spawns are exempt — v5 `_spawn_single`).
    const ledger = activeLedger(deps);
    const rlmBudget = deps.getConfig().rlmBudget;
    if (
      ledger !== undefined &&
      rlmBudget !== undefined &&
      rlmBudget > 0 &&
      ledger.rlmCount() >= rlmBudget
    ) {
      return spawnAndRun(
        sd,
        "llm",
        1,
        () =>
          runClaimedLeaf(
            ledger,
            leafClaimKey(deps, task),
            task,
            inv.depth,
            () =>
              emitting(
                inv,
                {
                  kind: "llm",
                  label: "rlm_query→llm (demoted)",
                  args: previewText(task),
                },
                (track, note) => complete1(inv, task, track, completeDeps(deps), throttleHooks(note)),
                summarizeLeaf,
              ),
          ),
        deps.trackDetached,
        opts.detached,
      );
    }

    return spawnAndRun(
      sd,
      "rlm",
      1,
      async () => {
        const r = await childRun(deps, inv, task, pathArg);
        return r.answer;
      },
      deps.trackDetached,
      opts.detached,
    );
  };
}

export function createRlmBatchHandler(deps: SubcallHandlerDeps, sd: SpawnDeps) {
  return async (
    tasks: readonly string[],
    depth: number,
    opts: SubcallOpts,
  ): Promise<SpawnResult> => {
    const inv = deps.resolve(opts, depth);
    if (inv === null) return unwiredSpawn("rlm_batch", tasks.length);

    const pathArg = opts.paths;
    // No wrapper "rlm_batch ×N" node: every task already gets its own rlm_query node from
    // childRun (DRY #2), parented to the caller — the batch is spawn fan-out, not a UI row.
    return spawnAndRun(
      sd,
      "rlm_batch",
      tasks.length,
      async () => {
        const results = await Promise.all(
          tasks.map((t) => childRun(deps, inv, t, pathArg)),
        );
        return results.map((r) => r.answer);
      },
      deps.trackDetached,
      opts.detached,
    );
  };
}
