/**
 * RlmController — holds RLM config + chosen models.
 *
 * The engine drives the root model turn-by-turn over ```repl``` blocks with full budget/token/
 * timeout/error guards, compaction, and a finalize fallback. `start()` returns a RunHandle with
 * the live AgentTree and the completion promise.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildProjectManifest } from "../bridge/fs-tools.ts";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { modelRef, resolveModelId, saveSettings } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import type { RlmConfig, RlmInput, RlmResult } from "../core/types.ts";
import { renderEditRequestPreview } from "../text/edit-preview.ts";
import { contextLength } from "../text/tokens.ts";
import { AgentTree } from "../state/agent-tree.ts";
import { observerWith } from "../state/events.ts";
import { createTelemetrySink, type TelemetrySink } from "../telemetry/index.ts";

const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

async function shutdownTelemetryBounded(sink: TelemetrySink | undefined): Promise<void> {
  if (!sink) return;
  await Promise.race([sink.shutdown(), timeout(TELEMETRY_FLUSH_TIMEOUT_MS)]);
}

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

  start(ctx: ExtensionContext, rootPrompt: string, context: unknown): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");

    const tree = new AgentTree();
    const abortController = new AbortController();
    this.active = abortController;

    const done = (async () => {
      const sink = await createTelemetrySink(this.config.telemetry);
      try {
        const workspaceRoot = ctx.cwd;
        const contextValue = await prepareRlmContext(context, workspaceRoot, this.config, abortController.signal);
        const engine = createEngine({
          smartModel: models.smart,
          workerModel: models.worker,
          registry: ctx.modelRegistry,
          config: this.config,
          signal: abortController.signal,
          observer: observerWith(tree, sink),
          onEditRequest: async (request) => {
            if (this.config.editRequestApproval === "yolo") return true;
            return ctx.hasUI ? ctx.ui.confirm("Approve RLM edit request?", renderEditRequestPreview(request)) : false;
          },
          limits: {
            maxBudgetUsd: this.config.maxBudgetUsd,
            maxTimeoutMs: this.config.maxTimeoutMs,
            maxTokens: this.config.maxTokens,
            maxErrors: this.config.maxErrors,
          },
        });
        const input: RlmInput = { rootPrompt, context: contextValue, depth: 0, workspaceRoot, projectMap: isProjectMapContext(context, contextValue, workspaceRoot) };
        return await engine(input);
      } finally {
        try {
          await shutdownTelemetryBounded(sink);
        } catch (err) {
          console.warn(`[rlm] telemetry shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })().finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { tree, abort: () => abortController.abort(), done };
  }
}
