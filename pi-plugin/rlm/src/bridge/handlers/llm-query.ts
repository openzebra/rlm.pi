/**
 * llm_query and llm_batch handlers — async-by-default spawn pattern.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { modelRef } from "../../config/settings.ts";
import { complete1, type Complete1Deps } from "./completion.ts";
import { emitting, summarizeBatch } from "./emitting.ts";
import { formatError, isErrorText, errorMessage } from "../../util/errors.ts";
import { previewText } from "../../text/preview.ts";
import type { SpawnResult, SubcallHandlerDeps } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import { SPAWN_HINT, spawnAndRun, type SpawnDeps } from "./task-registry.ts";
import { ECHO_STUB, taskKey, type TaskLedger } from "../../core/ledger.ts";

const UNWIRED = formatError("RLM bridge not wired for this invocation");

function completeDeps(deps: SubcallHandlerDeps): Complete1Deps {
  return {
    leafGate: deps.gates.leaf,
    registry: deps.registry,
    getLlmModel: deps.getLlmModel,
    getConfig: deps.getConfig,
    signal: deps.signal,
    onUsage: deps.onUsage,
  };
}

function displayModel(deps: SubcallHandlerDeps): string | undefined {
  try {
    const m = deps.getLlmModel();
    return modelRef(m) ?? m.id;
  } catch {
    return undefined;
  }
}

/** The ledger active for leaf calls — undefined when disabled by config or not threaded in. */
function activeLedger(deps: SubcallHandlerDeps): TaskLedger | undefined {
  return deps.getConfig().enableLedger ? deps.ledger : undefined;
}

/** v5 TaskLedger routing for ONE leaf prompt (audit H3 — shared by llm_query and every
 *  llm_batch item, which v5 routed through `_spawn_single` too): echo → stub string,
 *  coalesce → the twin's result (bounded wait), run → caller executes then finish/fail.
 *  Exported for tests. */
export async function runClaimedLeaf(
  ledger: TaskLedger | undefined,
  key: string | undefined,
  prompt: string,
  depth: number,
  exec: () => Promise<string>,
): Promise<string> {
  if (ledger === undefined || key === undefined) return exec();
  const decision = ledger.tryClaim({ kind: "llm", prompt, paths: [], depth }, key);
  if (decision.type === "echo") return ECHO_STUB;
  if (decision.type === "coalesce") {
    return ledger.waitFor(decision.key).catch((err: unknown): string => formatError(errorMessage(err)));
  }
  ledger.markRunning(key);
  try {
    const out = await exec();
    ledger.finish(key, out);
    return out;
  } catch (err: unknown) {
    ledger.fail(key, errorMessage(err));
    throw err;
  }
}

export function leafClaimKey(deps: SubcallHandlerDeps, prompt: string): string | undefined {
  const ledger = activeLedger(deps);
  if (ledger === undefined) return undefined;
  return taskKey("llm", prompt, [], displayModel(deps) ?? "", "");
}

export function createLlmQueryHandler(
  deps: SubcallHandlerDeps,
  sd: SpawnDeps,
) {
  return async (
    prompt: string,
    depth: number,
    opts: SubcallOpts,
  ): Promise<SpawnResult> => {
    const inv = deps.resolve(opts, depth);
    if (inv === null) {
      return {
        ok: false,
        task_id: null,
        kind: "llm",
        n: 1,
        status: "pending",
        hint: SPAWN_HINT,
        error: UNWIRED,
      };
    }

    const cdeps = completeDeps(deps);
    const runLeaf = (): Promise<string> =>
      emitting(
        inv,
        {
          kind: "llm",
          label: "llm_query",
          args: `prompt: ${previewText(prompt)}`,
          model: displayModel(deps),
        },
        (track: (u: Usage) => void) => complete1(inv, prompt, track, cdeps),
        (out) => ({
          preview: previewText(out),
          error: isErrorText(out) ? out : undefined,
        }),
      );
    // v5 TaskLedger for leaves: identical prompts coalesce onto one completion (key has no
    // context — a leaf's entire world is the prompt text itself).
    return spawnAndRun(
      sd,
      "llm",
      1,
      () => runClaimedLeaf(activeLedger(deps), leafClaimKey(deps, prompt), prompt, inv.depth, runLeaf),
      deps.trackDetached,
      opts.detached,
    );
  };
}

export function createLlmBatchHandler(
  deps: SubcallHandlerDeps,
  sd: SpawnDeps,
) {
  return async (
    prompts: readonly string[],
    depth: number,
    opts: SubcallOpts,
  ): Promise<SpawnResult> => {
    const inv = deps.resolve(opts, depth);
    if (inv === null) {
      return {
        ok: false,
        task_id: null,
        kind: "llm_batch",
        n: prompts.length,
        status: "pending",
        hint: SPAWN_HINT,
        error: UNWIRED,
      };
    }

    const cdeps = completeDeps(deps);
    const ledger = activeLedger(deps);
    return spawnAndRun(
      sd,
      "llm_batch",
      prompts.length,
      () =>
        emitting(
          inv,
          {
            kind: "batch",
            label: `llm_batch ×${prompts.length}`,
            args: `prompt: ${previewText(prompts[0] ?? "")}`,
            model: displayModel(deps),
          },
          // NO outer gate — complete1 takes the single leaf slot per prompt.
          // v5 (audit H3): every item routes through the ledger — duplicate prompts inside
          // one batch (or twins of other in-flight leaves) coalesce instead of paying N times.
          (track: (u: Usage) => void) =>
            Promise.all(
              prompts.map((p) =>
                runClaimedLeaf(
                  ledger,
                  ledger === undefined ? undefined : leafClaimKey(deps, p),
                  p,
                  inv.depth,
                  () => complete1(inv, p, track, cdeps),
                ),
              ),
            ),
          summarizeBatch,
        ),
      deps.trackDetached,
      opts.detached,
    );
  };
}
