/**
 * llm_query and llm_batch handlers — async-by-default spawn pattern.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { modelRef } from "../../config/settings.ts";
import { complete1, type Complete1Deps } from "./completion.ts";
import { emitting, summarizeBatch } from "./emitting.ts";
import { formatError, isErrorText } from "../../util/errors.ts";
import { previewText } from "../../text/preview.ts";
import type { SpawnResult, SubcallHandlerDeps } from "./types.ts";
import type { SubcallOpts } from "../../sandbox/interrupts.ts";
import { SPAWN_HINT, spawnAndRun, type SpawnDeps } from "./task-registry.ts";

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
    return spawnAndRun(
      sd,
      "llm",
      1,
      () =>
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
        ),
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
          (track: (u: Usage) => void) =>
            Promise.all(prompts.map((p) => complete1(inv, p, track, cdeps))),
          summarizeBatch,
        ),
      deps.trackDetached,
      opts.detached,
    );
  };
}
