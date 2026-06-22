/**
 * RlmController — holds RLM config + the chosen smart/worker models, and runs the engine.
 *
 * The root is engine-driven (reliable + observable): pi's selected model is the default *smart*
 * orchestrator; a cheaper *worker* model answers `llm_query`. A run streams into an AgentTree the
 * caller renders. Recursion (`rlm_query`) reuses the same engine.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModelId } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import type { RlmConfig, RlmResult } from "../core/types.ts";
import { AgentTree } from "../state/agent-tree.ts";
import { treeObserver } from "../state/events.ts";

/** Cheapest available model (sum of input+output price) — a sensible default worker. */
export function cheapestModel(registry: ModelRegistry): Model<Api> | undefined {
  const models = registry.getAvailable();
  if (models.length === 0) return undefined;
  return [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
}

export interface RunHandle {
  tree: AgentTree;
  abort: () => void;
  done: Promise<RlmResult>;
}

export class RlmController {
  smartModel: Model<Api> | undefined;
  workerModel: Model<Api> | undefined;
  /** "provider/id" refs restored from persisted settings, resolved lazily once a registry exists. */
  savedSmartRef: string | undefined;
  savedWorkerRef: string | undefined;
  private active: AbortController | null = null;

  constructor(public config: RlmConfig) {}

  isBusy(): boolean {
    return this.active !== null;
  }

  abort(): void {
    this.active?.abort();
  }

  /** Resolve the models actually used for a run given the current pi context. */
  resolveModels(ctx: ExtensionContext): { smart: Model<Api>; worker: Model<Api> } | undefined {
    // Restore persisted choices once a registry is available.
    if (!this.smartModel && this.savedSmartRef) this.smartModel = resolveModelId(ctx.modelRegistry, this.savedSmartRef);
    if (!this.workerModel && this.savedWorkerRef) this.workerModel = resolveModelId(ctx.modelRegistry, this.savedWorkerRef);

    const smart = this.smartModel ?? ctx.model ?? cheapestModel(ctx.modelRegistry);
    if (!smart) return undefined;
    const worker = this.workerModel ?? cheapestModel(ctx.modelRegistry) ?? smart;
    return { smart, worker };
  }

  /** Start an engine run. Returns immediately with a handle (tree + abort + completion promise). */
  start(ctx: ExtensionContext, rootPrompt: string, context: unknown): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");

    const tree = new AgentTree();
    const abortController = new AbortController();
    this.active = abortController;

    const engine = createEngine({
      smartModel: models.smart,
      workerModel: models.worker,
      registry: ctx.modelRegistry,
      config: this.config,
      signal: abortController.signal,
      observer: treeObserver(tree),
    });

    const done = engine({ rootPrompt, context, depth: 0 }).finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { tree, abort: () => abortController.abort(), done };
  }
}
