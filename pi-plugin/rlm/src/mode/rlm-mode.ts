/**
 * RlmController — holds RLM config + chosen models.
 *
 * The engine drives the root model turn-by-turn over ```repl``` blocks with full budget/token/
 * timeout/error guards, compaction, and a finalize fallback. `start()` returns a RunHandle with
 * the live AgentTree and the completion promise.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelRef, resolveModelId, saveSettings } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import type { RlmConfig, RlmResult } from "../core/types.ts";
import { AgentTree } from "../state/agent-tree.ts";
import { treeObserver } from "../state/events.ts";

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
  savedSmartRef: string | undefined;
  savedWorkerRef: string | undefined;
  private active: AbortController | null = null;

  constructor(public config: RlmConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.persist();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  hasSavedModels(): boolean {
    return Boolean(this.savedSmartRef || this.savedWorkerRef || this.smartModel || this.workerModel);
  }

  persist(): void {
    saveSettings({
      config: this.config,
      smart: modelRef(this.smartModel) ?? this.savedSmartRef,
      worker: modelRef(this.workerModel) ?? this.savedWorkerRef,
    });
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  abort(): void {
    this.active?.abort();
  }

  resolveModels(ctx: ExtensionContext): { smart: Model<Api>; worker: Model<Api> } | undefined {
    if (!this.smartModel && this.savedSmartRef) this.smartModel = resolveModelId(ctx.modelRegistry, this.savedSmartRef);
    if (!this.workerModel && this.savedWorkerRef) this.workerModel = resolveModelId(ctx.modelRegistry, this.savedWorkerRef);
    const smart = this.smartModel ?? ctx.model ?? cheapestModel(ctx.modelRegistry);
    if (!smart) return undefined;
    const worker = this.workerModel ?? cheapestModel(ctx.modelRegistry) ?? smart;
    return { smart, worker };
  }

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
      limits: {
        maxBudgetUsd: this.config.maxBudgetUsd,
        maxTimeoutMs: this.config.maxTimeoutMs,
        maxTokens: this.config.maxTokens,
        maxErrors: this.config.maxErrors,
      },
    });

    const done = engine({ rootPrompt, context, depth: 0 }).finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { tree, abort: () => abortController.abort(), done };
  }
}
