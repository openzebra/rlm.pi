/**
 * llm_query and llm_batch handlers — async-by-default spawn pattern.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { modelRef } from "../../config/settings.ts";
import { complete1, completeDeps } from "./completion.ts";
import { emitting, summarizeLeaf, throttleHooks, type EmitNote } from "./emitting.ts";
import { formatError, errorMessage } from "../../util/errors.ts";
import { previewText } from "../../text/preview.ts";
import type { Invocation, SpawnResult, SubcallHandlerDeps } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import { SPAWN_HINT, spawnAndRun, type SpawnDeps } from "./task-registry.ts";
import { ECHO_STUB, taskKey, type TaskLedger } from "../../core/ledger.ts";

const UNWIRED = formatError("RLM bridge not wired for this invocation");

function displayModel(deps: SubcallHandlerDeps): string | undefined {
  try {
    const m = deps.getLlmModel();
    return modelRef(m) ?? m.id;
  } catch {
    return undefined;
  }
}

/** The ledger active for leaf calls — undefined when disabled by config or not threaded in. */
export function activeLedger(deps: SubcallHandlerDeps): TaskLedger | undefined {
  return deps.getConfig().enableLedger ? deps.ledger : undefined;
}

/** DRY: one unwired-spawn shape — kind/n vary, everything else is the same rejection. */
function unwiredSpawn(kind: SpawnResult["kind"], n: number): SpawnResult {
  return { ok: false, task_id: null, kind, n, status: "pending", hint: SPAWN_HINT, error: UNWIRED };
}

/** DRY: the shared leaf recipe — one UI node, one complete1 execution, one summarizer. */
function emitLeaf(
  inv: Invocation,
  deps: SubcallHandlerDeps,
  prompt: string,
  exec: (track: (u: Usage) => void, note: EmitNote) => Promise<string>,
): Promise<string> {
  return emitting(
    inv,
    {
      kind: "llm",
      label: "llm_query",
      args: `prompt: ${previewText(prompt)}`,
      model: displayModel(deps),
    },
    (track, note) => exec(track, note),
    summarizeLeaf,
  );
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
    if (inv === null) return unwiredSpawn("llm", 1);

    const cdeps = completeDeps(deps);
    const runLeaf = (): Promise<string> =>
      emitLeaf(inv, deps, prompt, (track, note) =>
        complete1(inv, prompt, track, cdeps, throttleHooks(note)));
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
    if (inv === null) return unwiredSpawn("llm_batch", prompts.length);

    const cdeps = completeDeps(deps);
    const ledger = activeLedger(deps);
    return spawnAndRun(
      sd,
      "llm_batch",
      prompts.length,
      // One visible node per prompt — no collapsed "×N" row, no hidden failures: each item
      // reports its own status/tokens/error (UI parity with pi: every concurrent call renders).
      () =>
        Promise.all(
          prompts.map((p) =>
            emitLeaf(inv, deps, p, (track, note) =>
              // NO outer gate — complete1 takes the single leaf slot per prompt.
              // v5 (audit H3): every item routes through the ledger — duplicate prompts inside
              // one batch (or twins of other in-flight leaves) coalesce instead of paying N times.
              runClaimedLeaf(
                ledger,
                ledger === undefined ? undefined : leafClaimKey(deps, p),
                p,
                inv.depth,
                () => complete1(inv, p, track, cdeps, throttleHooks(note)),
              )),
          ),
        ),
      deps.trackDetached,
      opts.detached,
    );
  };
}
