/**
 * RlmController — holds RLM config + chosen models.
 *
 * The engine drives the root model turn-by-turn over ```repl``` blocks with full budget/token/
 * timeout/error guards, compaction, and a finalize fallback. `start()` returns a RunHandle with
 * the completion promise.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef, resolveModelId, saveSettings } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import { limitsFromConfig } from "../core/limits.ts";
import type { InteractiveDeps, RlmConfig, RlmResult } from "../core/types.ts";
import { packRepository, serializeForSandbox } from "../context/repomix-context.ts";
import { RlmEmitter } from "../tool/rlm-events.ts";
import { formatError } from "../util/errors.ts";
import { cheapestModel } from "./worker-model.ts";

export interface RunHandle {
  readonly abort: () => void;
  readonly done: Promise<RlmResult>;
}

export interface StartInput {
  readonly rootPrompt: string;
  readonly context: unknown;
}

export class RlmController {
  workerModel: Model<Api> | undefined;
  savedWorkerRef: string | undefined;
  private active: AbortController | null = null;

  constructor(public config: RlmConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Replace the config wholesale — `RlmConfig` is immutable, so edits produce a new object. */
  setConfig(config: RlmConfig): void {
    this.config = config;
  }

  setEnabled(enabled: boolean): void {
    this.config = Object.freeze({ ...this.config, enabled });
    void this.persist();
  }

  toggle(): boolean {
    const next = !this.enabled;
    this.setEnabled(next);
    if (!next) this.abort();   // turning the mode OFF also stops an in-flight run
    return next;
  }

  async persist(): Promise<boolean> {
    return await saveSettings({
      config: this.config,
      worker: modelRef(this.workerModel) ?? this.savedWorkerRef,
    });
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  abort(): void {
    this.active?.abort();
  }

  resolveModels(ctx: ExtensionContext): { model: Model<Api>; worker: Model<Api> } | undefined {
    if (!this.workerModel && this.savedWorkerRef) this.workerModel = resolveModelId(ctx.modelRegistry, this.savedWorkerRef);
    const model = ctx.model ?? cheapestModel(ctx.modelRegistry);
    if (!model) return undefined;
    const worker = this.workerModel ?? cheapestModel(ctx.modelRegistry) ?? model;
    return { model, worker };
  }

  start(ctx: ExtensionContext, input: StartInput, emitter?: RlmEmitter, interactive?: InteractiveDeps): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");
    if (this.active) throw new Error("RLM run already in progress"); // QC: mutual-exclusion guard

    const abortController = new AbortController();
    this.active = abortController;

    const done = (async () => {
      // Auto-pack empty/undefined context via repomix; pass explicit context through.
      let contextValue: unknown = input.context;
      if (contextValue === undefined || (typeof contextValue === "string" && contextValue.trim() === "")) {
        const cwd = ctx.cwd ?? process.cwd();
        const result = await packRepository(cwd, abortController.signal);
        contextValue = result.ok
          ? serializeForSandbox(result.value)
          : formatError(`failed to pack repository — ${result.error}`);
      }
      const engine = createEngine({
        model: models.model,
        workerModel: models.worker,
        registry: ctx.modelRegistry,
        config: this.config,
        signal: abortController.signal,
        emitter: emitter ?? new RlmEmitter(),
        onAskUserQuestion: interactive?.onAskUserQuestion,
        limits: limitsFromConfig(this.config),
      });
      return await engine({ rootPrompt: input.rootPrompt, context: contextValue, depth: 0 });
    })().finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { abort: () => abortController.abort(), done };
  }
}
