/**
 * RlmController — holds RLM config + chosen models.
 *
 * The engine drives the root model turn-by-turn over ```repl``` blocks with full token/
 * timeout/error guards, compaction, and a finalize fallback. `start()` returns a RunHandle with
 * the completion promise.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRef, resolveModelId, saveSettings } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import { limitsFromConfig } from "../core/limits.ts";
import type { RlmConfig, RlmResult } from "../core/types.ts";
import { resolveSource } from "../context/resolve.ts";
import { RlmEmitter } from "../tool/rlm-events.ts";
import { formatError } from "../util/errors.ts";
import { cheapestModel } from "./llm-model.ts";

export interface RunHandle {
  readonly abort: () => void;
  readonly done: Promise<RlmResult>;
}

export interface StartInput {
  readonly rootPrompt: string;
  readonly context: unknown;
}

export class RlmController {
  llmModel: Model<Api> | undefined;
  savedLlmRef: string | undefined;
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
      llm: modelRef(this.llmModel) ?? this.savedLlmRef,
    });
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  abort(): void {
    this.active?.abort();
  }

  resolveModels(ctx: ExtensionContext): { model: Model<Api>; llm: Model<Api> } | undefined {
    if (!this.llmModel && this.savedLlmRef) this.llmModel = resolveModelId(ctx.modelRegistry, this.savedLlmRef);
    const model = ctx.model ?? cheapestModel(ctx.modelRegistry);
    if (!model) return undefined;
    const llm = this.llmModel ?? cheapestModel(ctx.modelRegistry) ?? model;
    return { model, llm };
  }

  start(ctx: ExtensionContext, input: StartInput, emitter?: RlmEmitter): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");
    if (this.active) throw new Error("RLM run already in progress"); // QC: mutual-exclusion guard

    const abortController = new AbortController();
    this.active = abortController;

    const done = (async () => {
      // Auto-seed empty/undefined context from cwd (same resolveSource path as native mode);
      // pass explicit context through.
      let contextValue: unknown = input.context;
      if (contextValue === undefined || (typeof contextValue === "string" && contextValue.trim() === "")) {
        const cwd = ctx.cwd ?? process.cwd();
        const result = await resolveSource(cwd, { cwd, pathPrefix: "", signal: abortController.signal });
        contextValue = result.ok
          ? result.value.payload
          : formatError(`failed to pack repository — ${result.error}`);
      }
      const engine = createEngine({
        model: models.model,
        llmModel: models.llm,
        registry: ctx.modelRegistry,
        config: this.config,
        signal: abortController.signal,
        emitter: emitter ?? new RlmEmitter(),
        limits: limitsFromConfig(this.config),
      });
      return await engine({ rootPrompt: input.rootPrompt, context: contextValue, depth: 0 });
    })().finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { abort: () => abortController.abort(), done };
  }
}
