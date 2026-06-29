/**
 * repl() tool — executes Python code in the persistent RLM sandbox.
 *
 * Registered as a Pi tool so the main agent can use `repl({code: "..."})` alongside
 * its normal tool suite. Each call creates a fresh RlmEmitter for sub-call tracking
 * and collects sub-calls manually from emitter events. No RlmEventAggregator is used
 * (ReplDetails ≠ RlmDetails structural mismatch).
 *
 * Sandbox handlers (llm_query, rlm_query, todo, ask_user_question) use mutable refs
 * so the tool can swap per-invocation state (emitter, depth, limits) without recreating
 * the sandbox — preserving REPL variable state across calls.
 */

import { Type } from "typebox";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Model, Usage, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelRef, resolveModelId } from "../config/settings.ts";
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { previewText } from "../text/preview.ts";
import { mapPool } from "../util/concurrency.ts";
import { LimitGuard } from "../core/limits.ts";
import { checkResourceLimits } from "../core/resource-limits.ts";
import type { RlmConfig, Sampling } from "../core/types.ts";
import { SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import { RlmEmitter } from "./rlm-events.ts";
import { SubcallStore } from "./subcall-store.ts";
import type { ReplDetails } from "./repl-details.ts";
import { createEngine } from "../core/engine.ts";
import { formatCost, formatTokens, spinnerFrame } from "../ui/theme.ts";
import { errorMessage, formatError, isErrorText } from "../util/errors.ts";
import {
  headlineStatusGlyph,
  renderCollapsedSubcallTree,
  renderExpandedSubcallTree,
} from "./subcall-render.ts";
import { createProgressNotifier, validateToolParams } from "./tool-utils.ts";

// ── Parameter schema ──

export const ReplToolParams = Object.freeze(Type.Object({
  code: Type.String({ description: "Python code to execute in the persistent REPL sandbox" }),
}));

// ── Mutable bridge state (handler indirection) ──

/**
 * Holds per-invocation mutable state that sandbox handlers dereference.
 * The sandbox is created once with handlers that read from this object's
 * current fields, so the tool can swap emitter/depth/limits between calls
 * without recreating the sandbox (preserving REPL variable state).
 */
class NativeBridgeState {
  currentEmitter: RlmEmitter | null = null;
  currentParentId: string | undefined;
  currentDepth = 0;
  currentLimits: LimitGuard | null = null;

  swap(inv: { emitter: RlmEmitter; parentId?: string; depth: number; limits: LimitGuard }): void {
    this.currentEmitter = inv.emitter;
    this.currentParentId = inv.parentId;
    this.currentDepth = inv.depth;
    this.currentLimits = inv.limits;
  }

  buildLlmHandlers(deps: {
    workerModel: Model<Api>;
    getWorkerModel?: () => Model<Api> | undefined;
    registry: ModelRegistry;
    maxPromptChars: number;
    maxConcurrent: number;
    sampling?: Sampling;
    subSystem?: string;
    signal?: AbortSignal;
  }): Pick<SubLlmHandlers, "llmQuery" | "llmQueryBatched"> {
    const state = this;

    const workerModel = (): Model<Api> => deps.getWorkerModel?.() ?? deps.workerModel;
    const displayModel = (model: string | null): string =>
      modelRef(model ? (resolveModelId(deps.registry, model) ?? workerModel()) : workerModel()) ?? workerModel().id;

    async function complete1(prompt: string, model: string | null, track: (u: Usage) => void): Promise<string> {
      if (prompt.length > deps.maxPromptChars) {
        return formatError(`sub-LLM prompt exceeded size limit (${prompt.length.toLocaleString()} chars > ${deps.maxPromptChars.toLocaleString()})`);
      }
      const resolved = model ? resolveModelId(deps.registry, model) : undefined;
      if (model && !resolved) return formatError(`unknown model override '${model}'`);
      try {
        const messages: ChatMsg[] = [{ role: "user", content: prompt }];
        const res = await modelComplete(messages, {
          model: resolved ?? workerModel(),
          registry: deps.registry,
          system: deps.subSystem,
          maxTokens: deps.sampling?.maxTokens,
          temperature: deps.sampling?.temperature,
          reasoning: deps.sampling?.reasoning,
          signal: deps.signal,
        });
        track(res.usage);
        return res.text;
      } catch (err) {
        const msg = errorMessage(err);
        const hint = /credit|402|payment|quota|rate.limit/i.test(msg)
          ? " — try smaller batches or individual llm_query calls"
          : "";
        return formatError(`${msg}${hint}`);
      }
    }

    return {
      async llmQuery(prompt, model, _depth) {
        const id = state.currentEmitter?.emitSubcallCreated({
          kind: "llm", parentId: state.currentParentId, label: "llm_query",
          model: displayModel(model), args: `prompt: ${previewText(prompt)}`,
          depth: state.currentDepth,
        });
        let cost = 0; let tokens = 0;
        const out = await complete1(prompt, model, (u) => { cost += u.cost.total; tokens += u.totalTokens; });
        if (id) state.currentEmitter?.emitSubcallUpdated({ id,
          status: isErrorText(out) ? "error" : "done",
          costUsd: cost, tokens, resultPreview: previewText(out),
          detail: isErrorText(out) ? out : undefined,
        });
        state.currentLimits?.addRaw(cost, 0, tokens);
        return out;
      },

      async llmQueryBatched(prompts: readonly string[], model, _depth): Promise<string[]> {
        const id = state.currentEmitter?.emitSubcallCreated({
          kind: "batch", parentId: state.currentParentId, label: `llm_query ×${prompts.length}`,
          model: displayModel(model), args: `prompt: ${previewText(prompts[0] ?? "")}`,
          depth: state.currentDepth,
        });
        let cost = 0; let tokens = 0;
        const out: string[] = await mapPool(prompts, deps.maxConcurrent, (p) =>
          complete1(p, model, (u) => { cost += u.cost.total; tokens += u.totalTokens; }),
        );
        const failed = out.filter(isErrorText).length;
        const allFailed = failed === out.length;
        const error = allFailed
          ? `all ${out.length} sub-calls failed — reduce batch size or try llm_query individually`
          : failed > 0 ? `${failed}/${out.length} sub-calls failed` : undefined;
        if (id) state.currentEmitter?.emitSubcallUpdated({ id,
          status: error ? "error" : "done", costUsd: cost, tokens,
          resultPreview: previewText(out[0] ?? ""), detail: error,
        });
        state.currentLimits?.addRaw(cost, 0, tokens);
        return out;
      },
    };
  }

  /**
   * Build real recursive rlm_query / rlm_query_batched handlers that spawn
   * child RLM engines (each with its own sandbox and turn loop) rather than
   * falling back to a one-shot llm_query.
   *
   * At the maxDepth cap the handler degrades to a plain llm_query via the
   * already-wired llmHandlers (which read from the same mutable state).
   */
  buildRlmHandlers(deps: {
    model: Model<Api>;
    workerModel: Model<Api>;
    getModel?: () => Model<Api> | undefined;
    getWorkerModel?: () => Model<Api> | undefined;
    registry: ModelRegistry;
    config: RlmConfig;
    signal?: AbortSignal;
    onUsage?: (usage: Usage, role: "sub") => void;
    llmHandlers: Pick<SubLlmHandlers, "llmQuery" | "llmQueryBatched">;
  }): Pick<SubLlmHandlers, "rlmQuery" | "rlmQueryBatched"> {
    const state = this;

    async function rlmQueryImpl(prompt: string, model: string | null, depth: number): Promise<string> {
      const emitter = state.currentEmitter;
      const limits = state.currentLimits;
      if (!emitter || !limits) return formatError("RLM bridge not wired for this invocation");

      const childDepth = state.currentDepth + 1;

      // Depth cap: degrade to a one-shot llm_query.
      if (childDepth >= deps.config.maxDepth) {
        return deps.llmHandlers.llmQuery(prompt, model, depth);
      }

      const remBudget = limits.remainingBudgetUsd();
      const remTimeout = limits.remainingTimeoutMs();
      const limitError = checkResourceLimits({ budgetUsd: remBudget, timeoutMs: remTimeout });
      if (limitError) return limitError;

      const rootModel = deps.getModel?.() ?? deps.model;
      const workerModel = deps.getWorkerModel?.() ?? deps.workerModel;
      const resolvedOverride = model ? resolveModelId(deps.registry, model) : undefined;
      const subId = emitter.emitSubcallCreated({
        kind: "rlm", parentId: state.currentParentId, label: "rlm_query",
        model: model ? (modelRef(resolvedOverride) ?? `unknown/${model}`) : (modelRef(rootModel) ?? rootModel.id),
        detail: prompt.slice(0, 60),
        depth: childDepth,
      });

      // Per-call engine creation with the visible emitter — child llm_query subcalls,
      // turn progress, and cost deltas land on the per-invocation emitter, visible to
      // SubcallStore and the live visual tree.
      const runRlm = createEngine({
        model: rootModel,
        workerModel,
        registry: deps.registry,
        config: deps.config,
        signal: deps.signal,
        emitter: emitter,
        onUsage: deps.onUsage as ((usage: Usage, role: "root" | "sub") => void) | undefined,
        limits: {
          maxBudgetUsd: deps.config.maxBudgetUsd,
          maxTimeoutMs: deps.config.maxTimeoutMs,
          maxTokens: deps.config.maxTokens,
          maxErrors: deps.config.maxErrors,
        },
      });

      try {
        const res = await runRlm({
          rootPrompt: "",
          context: prompt,
          depth: childDepth,
          parentNodeId: subId,
          modelOverride: model ?? undefined,
          remainingBudgetUsd: remBudget,
          remainingTimeoutMs: remTimeout,
        });

        // Debit parent limit guard for the entire child run.
        limits.addRaw(res.costUsd, res.inputTokens, res.outputTokens);

        // Child engine emits live usage deltas via the shared emitter — SubcallStore
        // accumulates them. No final aggregate costUsd/tokens to prevent double-counting
        // (matches canonical rlm-query.ts:60-63).
        emitter.emitSubcallUpdated({
          id: subId,
          status: "done",
          resultPreview: res.answer.slice(0, 200),
        });

        return res.answer;
      } catch (err) {
        const msg = errorMessage(err);
        emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
        return formatError(`child RLM failed - ${msg}`);
      }
    }

    return {
      rlmQuery: rlmQueryImpl,
      rlmQueryBatched: (prompts, model, depth) =>
        mapPool(prompts, deps.config.maxConcurrentSubcalls, (p) => rlmQueryImpl(p, model, depth)),
    };
  }
}

// ── Tool factory ──

export interface ReplToolDeps {
  readonly sandboxManager: SandboxManager;
  readonly model: Model<Api>;
  readonly workerModel: Model<Api>;
  readonly getModel?: () => Model<Api> | undefined;
  readonly getWorkerModel?: () => Model<Api> | undefined;
  readonly registry: ModelRegistry;
  readonly config: RlmConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
}

export function createReplTool(deps: ReplToolDeps): ToolDefinition<typeof ReplToolParams, ReplDetails> {
  const { sandboxManager, workerModel, registry, config, signal, onUsage } = deps;
  const bridgeState = new NativeBridgeState();

  // Build handlers once — llm/rlm use mutable refs, interactive is session-stable
  const llmHandlers = bridgeState.buildLlmHandlers({
    workerModel,
    getWorkerModel: deps.getWorkerModel,
    registry,
    maxPromptChars: config.maxPromptChars,
    maxConcurrent: config.maxConcurrentSubcalls,
    sampling: config.subSampling,
    subSystem: config.subSystemPrompt,
    signal,
  });

  // Real recursive rlm_query via createEngine — each call spawns a child RLM
  // with its own sandbox and turn loop, not a flat one-shot llm_query.
  const rlmHandlers = bridgeState.buildRlmHandlers({
    model: deps.model,
    workerModel,
    getModel: deps.getModel,
    getWorkerModel: deps.getWorkerModel,
    registry,
    config,
    signal,
    onUsage,
    llmHandlers,
  });

  return {
    name: "repl",
    label: "REPL",
    description: "Execute Python code in a persistent REPL sandbox with the full repository context pre-loaded. Variables, imports, and state persist across calls. Supports llm_query, rlm_query, todo, and ask_user_question inside the sandbox.",
    parameters: ReplToolParams,

    async execute(_toolCallId, rawParams, _execSignal, onUpdate, ctx) {
      const validation = validateToolParams(ReplToolParams, rawParams, "REPL", (errors): ReplDetails => ({
        status: "error",
        output: "",
        stderr: errors,
        executionTimeMs: 0,
        subcalls: [],
        totals: { costUsd: 0, tokens: 0 },
      }));
      if (!validation.ok) return validation.error;
      const params = validation.value;

      const emitter = new RlmEmitter();
      const store = new SubcallStore(emitter);
      let capturedStdout = "";
      let capturedStderr = "";
      let progressStatus: ReplDetails["status"] = "running";
      const startedAt = Date.now();
      const limits = new LimitGuard({
        maxBudgetUsd: config.maxBudgetUsd,
        maxTimeoutMs: config.maxTimeoutMs,
        maxTokens: config.maxTokens,
        maxErrors: config.maxErrors,
      });

      // ── Progressive rendering: spinner + live sub-call tree ──
      const progress = createProgressNotifier<ReplDetails>({
        onUpdate,
        getDetails: () => ({
          status: progressStatus,
          output: capturedStdout,
          stderr: capturedStderr,
          executionTimeMs: Date.now() - startedAt,
          subcalls: store.getSubcalls(),
          totals: store.getTotals(),
        }),
        isRunning: (details) => details.status === "running",
        renderText: (details) => details.output.slice(0, 500) || (details.status === "running" ? `${spinnerFrame()} Running…` : "(no output)"),
      });
      progress.start();

      // Detect queue contention: notify if another repl() is already executing
      let queuedId: string | undefined;
      if (sandboxManager.isExecuting) {
        queuedId = emitter.emitSubcallCreated({
          kind: "tool", parentId: undefined, label: "repl:queued",
          args: "waiting for previous repl() to finish",
          depth: 0,
        });
      }

      try {
        // Build interactive handlers (session-stable callbacks)
        const interactive = createPiInteractiveDeps(ctx);
        const interactiveHandlers = buildInteractiveHandlers({
          onAskUserQuestion: config.askUserQuestion ? interactive.onAskUserQuestion : undefined,
          onProposeDiff: interactive.onProposeDiff,
          onTodo: interactive.onTodo,
          onTodoRow: undefined,
          emitter,
          depth: 0,
          parentId: undefined,
        });

        await sandboxManager.getOrCreate({
          ...llmHandlers,
          ...rlmHandlers,
          askUserQuestion: interactiveHandlers.askUserQuestion,
          proposeDiff: interactiveHandlers.proposeDiff,
          todo: interactiveHandlers.todo,
        });

        // Detect queue contention AFTER sandbox init (initPromise settled, isExecuting now accurate)
        if (!queuedId && sandboxManager.isExecuting) {
          queuedId = emitter.emitSubcallCreated({
            kind: "tool", parentId: undefined, label: "repl:queued",
            args: "waiting for previous repl() to finish",
            depth: 0,
          });
        }

        const start = Date.now();
        const result: ReplResult = await sandboxManager.execWithSetup(params.code, () => {
          // Wire per-invocation mutable state only after the serialized exec slot
          // is active. Swapping earlier would let queued repl() calls overwrite
          // emitter/limits for the currently running REPL execution.
          bridgeState.swap({ emitter, parentId: undefined, depth: 0, limits });
        });
        const elapsed = Date.now() - start;
        capturedStdout = result.stdout;
        capturedStderr = result.stderr;
        progressStatus = "done";

        const totals = store.getTotals();
        const subUsage: Usage = {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: totals.tokens,
          cost: { total: totals.costUsd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        onUsage?.(subUsage, "sub");

        if (queuedId) emitter.emitSubcallUpdated({ id: queuedId, status: "done" });

        const details: ReplDetails = {
          status: "done",
          output: result.stdout,
          stderr: result.stderr,
          executionTimeMs: elapsed,
          subcalls: store.getSubcalls(),
          totals: store.getTotals(),
        };
        // Final progressive update
        onUpdate?.({ content: [{ type: "text", text: result.stdout.slice(0, 500) || "(no output)" }], details });
        return { content: [{ type: "text", text: result.stdout || result.answerContent || "(no output)" }], details };
      } catch (e) {
        progressStatus = "error";
        const msg = errorMessage(e);
        const details: ReplDetails = {
          status: "error",
          output: "",
          stderr: msg,
          executionTimeMs: 0,
          subcalls: store.getSubcalls(),
          totals: store.getTotals(),
        };
        onUpdate?.({ content: [{ type: "text", text: `REPL error: ${msg}` }], details });
        return {
          content: [{ type: "text", text: `REPL error: ${msg}` }],
          details,
        };
      } finally {
        progress.stop();
        store.dispose();
        emitter.shutdown();
      }
    },

    renderCall(args, theme) {
      const preview = args.code.length > 80 ? `${args.code.slice(0, 80)}...` : args.code;
      return new Text(
        theme.fg("toolTitle", theme.bold("repl ")) +
        theme.fg("dim", preview.replace(/\n/g, " ")),
        0, 0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ReplDetails | undefined;
      if (!details) return new Text("(no output)", 0, 0);

      if (expanded) {
        return renderReplExpanded(details, theme);
      }
      return renderReplCollapsed(details, theme);
    },
  };
}

// ── Collapsed view ──

function renderReplCollapsed(details: ReplDetails, theme: Theme): Text {
  const glyph = details.status === "running"
    ? headlineStatusGlyph("running", theme)
    : details.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");

  const parts: string[] = [];
  parts.push(formatCost(details.totals.costUsd));
  if (details.totals.tokens > 0) parts.push(`${formatTokens(details.totals.tokens)} tok`);
  if (details.executionTimeMs > 0) parts.push(`${details.executionTimeMs}ms`);
  const stats = parts.length > 0 ? ` ${theme.fg("dim", parts.join(" · "))}` : "";

  const header = `${glyph} ${theme.fg("toolTitle", theme.bold("REPL"))}${stats}`;

  let body = "";
  if (details.subcalls.length > 0) {
    body = `\n${renderCollapsedSubcallTree(details.subcalls, theme)}`;
  }

  const expandHint = details.status === "running" ? "" : `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(`${header}${body}${expandHint}`, 0, 0);
}

// ── Expanded view ──

function renderReplExpanded(details: ReplDetails, theme: Theme): Container {
  const container = new Container();

  // Header: status + stats
  const glyph = details.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const parts: string[] = [];
  parts.push(formatCost(details.totals.costUsd));
  if (details.totals.tokens > 0) parts.push(`${formatTokens(details.totals.tokens)} tok`);
  if (details.executionTimeMs > 0) parts.push(`${details.executionTimeMs}ms`);
  const stats = parts.length > 0 ? ` · ${theme.fg("dim", parts.join(" · "))}` : "";
  container.addChild(new Text(`${glyph} ${theme.fg("toolTitle", theme.bold("REPL"))}${stats}`, 0, 0));

  // Output
  if (details.output) {
    container.addChild(new Spacer(1));
    const out = details.output.length > 2000 ? `${details.output.slice(0, 2000)}...` : details.output;
    container.addChild(new Text(out, 0, 0));
  }

  // Stderr
  if (details.stderr) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", details.stderr.slice(0, 500)), 0, 0));
  }

  // Sub-call tree
  if (details.subcalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));
    container.addChild(renderExpandedSubcallTree(details.subcalls, theme));
  }

  return container;
}
