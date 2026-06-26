/**
 * RlmController — holds RLM config + chosen models.
 *
 * The engine drives the root model turn-by-turn over ```repl``` blocks with full budget/token/
 * timeout/error guards, compaction, and a finalize fallback. `start()` returns a RunHandle with
 * the completion promise.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildProjectManifest } from "../bridge/fs-tools.ts";
import { DEFAULT_CONFIG, DEFAULT_RUN_DIR } from "../config/defaults.ts";
import { modelRef, resolveModelId, saveSettings } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import type { InteractiveDeps, RlmConfig, RlmInput, RlmResult } from "../core/types.ts";
import type { ReconstructResult } from "../state/resume.ts";
import { renderUnifiedDiffRequestPreview } from "../text/edit-preview.ts";
import { contextLength } from "../text/tokens.ts";
import { RlmToolBridge } from "../tool/rlm-details.ts";

export function cheapestModel(registry: ModelRegistry): Model<Api> | undefined {
  const models = registry.getAvailable();
  if (models.length === 0) return undefined;
  return [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
}

export interface RunHandle {
  abort: () => void;
  done: Promise<RlmResult>;
}

/** B5+SA: discriminated union removes non-null `!` assertions and the `context: ""` hack. */
export type StartInput =
  | { readonly kind: "fresh"; readonly rootPrompt: string; readonly context: unknown }
  | { readonly kind: "resume"; readonly resume: ReconstructResult & { ok: true }; readonly context: unknown };

export async function prepareRlmContext(context: unknown, cwd: string | undefined, config: RlmConfig = DEFAULT_CONFIG, signal?: AbortSignal): Promise<unknown> {
  return contextLength(context) === 0 && cwd ? buildProjectManifest(cwd, { signal, limits: config.fsLimits }) : context;
}

function isProjectMapContext(originalContext: unknown, preparedContext: unknown, cwd: string | undefined): boolean {
  return Boolean(cwd && contextLength(originalContext) === 0 && contextLength(preparedContext) > 0);
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
    const next = !this.enabled;
    this.setEnabled(next);
    if (!next) this.abort();   // turning the mode OFF also stops an in-flight run
    return next;
  }

  hasSavedModels(): boolean {
    return Boolean(this.savedSmartRef || this.savedWorkerRef || this.smartModel || this.workerModel);
  }

  persist(): boolean {
    return saveSettings({
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

  start(ctx: ExtensionContext, input: StartInput, bridge?: RlmToolBridge, interactive?: InteractiveDeps): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");
    if (this.active) throw new Error("RLM run already in progress"); // QC: mutual-exclusion guard

    const abortController = new AbortController();
    this.active = abortController;

    const runState = this.config.runLog?.enabled !== false
      ? { cwd: ctx.cwd ?? process.cwd(), dir: this.config.runLog?.dir ?? DEFAULT_RUN_DIR, snapshot: this.config.runLog?.snapshot !== false }
      : undefined;

    const done = (async () => {
      const workspaceRoot = ctx.cwd;
      let engineInput: RlmInput;
      if (input.kind === "fresh") {
        const contextValue = await prepareRlmContext(input.context, workspaceRoot, this.config, abortController.signal);
        engineInput = {
          rootPrompt: input.rootPrompt,
          context: contextValue,
          depth: 0,
          workspaceRoot,
          projectMap: isProjectMapContext(input.context, contextValue, workspaceRoot),
        };
      } else {
        engineInput = {
          rootPrompt: input.resume.header.rootPrompt,
          context: input.context, // B5: load the actual context from the sidecar, not ""
          depth: 0,
          workspaceRoot,
          projectMap: input.resume.header.context.projectMap,
          resume: input.resume,
        };
      }
      const engine = createEngine({
        smartModel: models.smart,
        workerModel: models.worker,
        registry: ctx.modelRegistry,
        config: this.config,
        signal: abortController.signal,
        bridge: bridge ?? new RlmToolBridge(() => {}),
        runState,
        onAskUserQuestion: interactive?.onAskUserQuestion,
        onTodo: interactive?.onTodo,
        onEditRequest: async (request) => ctx.hasUI
          ? ctx.ui.confirm("Approve RLM diff edit request?", renderUnifiedDiffRequestPreview(request))
          : false,
        limits: {
          maxBudgetUsd: this.config.maxBudgetUsd,
          maxTimeoutMs: this.config.maxTimeoutMs,
          maxTokens: this.config.maxTokens,
          maxErrors: this.config.maxErrors,
        },
      });
      return await engine(engineInput);
    })().finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { abort: () => abortController.abort(), done };
  }
}
