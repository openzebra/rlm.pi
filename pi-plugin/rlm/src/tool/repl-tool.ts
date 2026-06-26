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
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Model, Usage, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModelId } from "../config/settings.ts";
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { previewText } from "../text/preview.ts";
import { mapPool } from "../util/concurrency.ts";
import { LimitGuard } from "../core/limits.ts";
import type { RlmConfig, Sampling } from "../core/types.ts";
import { SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import { RlmEmitter } from "./rlm-events.ts";
import type { ReplDetails } from "./repl-details.ts";
import type { RlmSubcall } from "./rlm-details.ts";
import { createEngine } from "../core/engine.ts";

// ── Parameter schema ──

export const ReplToolParams = Type.Object({
  code: Type.String({ description: "Python code to execute in the persistent REPL sandbox" }),
});

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
    registry: ModelRegistry;
    maxPromptChars: number;
    maxConcurrent: number;
    sampling?: Sampling;
    signal?: AbortSignal;
  }): Pick<SubLlmHandlers, "llmQuery" | "llmQueryBatched"> {
    const state = this;

    async function complete1(prompt: string, model: string | null, track: (u: Usage) => void): Promise<string> {
      if (prompt.length > deps.maxPromptChars) {
        return `Error: sub-LLM prompt exceeded size limit (${prompt.length.toLocaleString()} chars > ${deps.maxPromptChars.toLocaleString()})`;
      }
      const resolved = model ? resolveModelId(deps.registry, model) : undefined;
      if (model && !resolved) return `Error: unknown model override '${model}'`;
      try {
        const messages: ChatMsg[] = [{ role: "user", content: prompt }];
        const res = await modelComplete(messages, {
          model: resolved ?? deps.workerModel,
          registry: deps.registry,
          maxTokens: deps.sampling?.maxTokens,
          temperature: deps.sampling?.temperature,
          reasoning: deps.sampling?.reasoning,
          signal: deps.signal,
        });
        track(res.usage);
        return res.text;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      async llmQuery(prompt, model, _depth) {
        const id = state.currentEmitter?.emitSubcallCreated({
          kind: "llm", parentId: state.currentParentId, label: "llm_query",
          model: deps.workerModel.id, args: `prompt: ${previewText(prompt)}`,
          depth: state.currentDepth,
        });
        let cost = 0; let tokens = 0;
        const out = await complete1(prompt, model, (u) => { cost += u.cost.total; tokens += u.totalTokens; });
        if (id) state.currentEmitter?.emitSubcallUpdated({ id,
          status: out.startsWith("Error:") ? "error" : "done",
          costUsd: cost, tokens, resultPreview: previewText(out),
          detail: out.startsWith("Error:") ? out : undefined,
        });
        state.currentLimits?.addRaw(cost, 0, tokens);
        return out;
      },

      async llmQueryBatched(prompts: readonly string[], model, _depth): Promise<string[]> {
        const id = state.currentEmitter?.emitSubcallCreated({
          kind: "batch", parentId: state.currentParentId, label: `llm_query ×${prompts.length}`,
          model: deps.workerModel.id, args: `prompt: ${previewText(prompts[0] ?? "")}`,
          depth: state.currentDepth,
        });
        let cost = 0; let tokens = 0;
        const out: string[] = await mapPool([...prompts], deps.maxConcurrent, (p) =>
          complete1(p, model, (u) => { cost += u.cost.total; tokens += u.totalTokens; }),
        );
        const failed = out.filter((o: string) => o.startsWith("Error:")).length;
        const error = failed === out.length ? `all ${out.length} sub-calls failed`
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
    smartModel: Model<Api>;
    workerModel: Model<Api>;
    registry: ModelRegistry;
    config: RlmConfig;
    signal?: AbortSignal;
    onUsage?: (usage: Usage, role: "sub") => void;
    llmHandlers: Pick<SubLlmHandlers, "llmQuery" | "llmQueryBatched">;
  }): Pick<SubLlmHandlers, "rlmQuery" | "rlmQueryBatched"> {
    const state = this;

    // Separate emitter for the recursion sub-tree — child engines emit here,
    // and the parent's per-invocation emitter gets subcall events forwarded.
    const engineEmitter = new RlmEmitter();

    // Create the headless engine once; reuse across all rlm_query calls.
    // Each invocation swaps fresh limits/budget via remainingBudget/remainingTimeout.
    const runRlm = createEngine({
      smartModel: deps.smartModel,
      workerModel: deps.workerModel,
      registry: deps.registry,
      config: deps.config,
      signal: deps.signal,
      emitter: engineEmitter,
      // Cast: ReplToolDeps.onUsage is role:"sub" but EngineDeps accepts role:"root"|"sub".
      // Child engines always report as "sub" at this level — safe to widen.
      onUsage: deps.onUsage as ((usage: Usage, role: "root" | "sub") => void) | undefined,
      limits: {
        maxBudgetUsd: deps.config.maxBudgetUsd,
        maxTimeoutMs: deps.config.maxTimeoutMs,
        maxTokens: deps.config.maxTokens,
        maxErrors: deps.config.maxErrors,
      },
    });

    async function rlmQueryImpl(prompt: string, model: string | null, depth: number): Promise<string> {
      const emitter = state.currentEmitter;
      const limits = state.currentLimits;
      if (!emitter || !limits) return "Error: RLM bridge not wired for this invocation";

      const childDepth = state.currentDepth + 1;

      // Depth cap: degrade to a one-shot llm_query (same as headless engine recursion).
      if (childDepth >= deps.config.maxDepth) {
        return deps.llmHandlers.llmQuery(prompt, model, depth);
      }

      const remBudget = limits.remainingBudgetUsd();
      const remTimeout = limits.remainingTimeoutMs();
      if (remBudget !== undefined && remBudget <= 0) return "Error: budget exhausted";
      if (remTimeout !== undefined && remTimeout <= 0) return "Error: timeout exhausted";

      const subId = emitter.emitSubcallCreated({
        kind: "rlm", parentId: state.currentParentId, label: "rlm_query",
        model: model ?? deps.smartModel.id,
        detail: prompt.slice(0, 60),
        depth: childDepth,
      });

      try {
        const res = await runRlm({
          rootPrompt: "",
          context: prompt,
          depth: childDepth,
          parentNodeId: subId,
          smartModelOverride: model ?? undefined,
          remainingBudgetUsd: remBudget,
          remainingTimeoutMs: remTimeout,
        });

        // Debit the parent limit guard for the entire child run.
        limits.addRaw(res.costUsd, res.inputTokens, res.outputTokens);

        emitter.emitSubcallUpdated({
          id: subId,
          status: "done",
          costUsd: res.costUsd,
          tokens: res.inputTokens + res.outputTokens,
          resultPreview: res.answer.slice(0, 200),
        });

        return res.answer;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
        return `Error: child RLM failed - ${msg}`;
      }
    }

    return {
      rlmQuery: rlmQueryImpl,
      rlmQueryBatched: (prompts, model, depth) =>
        mapPool([...prompts], deps.config.maxConcurrentSubcalls, (p) => rlmQueryImpl(p, model, depth)),
    };
  }
}

// ── Sub-call collector ──

/** Collects sub-call state from RlmEmitter events for a single repl() invocation. */
class SubcallCollector {
  readonly subcalls: RlmSubcall[] = [];
  totals = { costUsd: 0, tokens: 0 };
  private readonly unsubs: (() => void)[];

  constructor(emitter: RlmEmitter) {
    this.unsubs = [
      emitter.onSubcallCreated((e) => {
        this.subcalls.push({ id: e.id, parentId: e.parentId, kind: e.kind, label: e.label,
          model: e.model, status: "running", detail: e.detail, args: e.args,
          startedAt: Date.now(), costUsd: 0, tokens: 0 });
      }),
      emitter.onSubcallUpdated((e) => {
        const sc = this.subcalls.find((s) => s.id === e.id);
        if (!sc) return;
        if (e.status !== undefined) { sc.status = e.status; if (e.status !== "running") sc.endedAt = Date.now(); }
        if (e.detail !== undefined) sc.detail = e.detail;
        if (e.args !== undefined) sc.args = e.args;
        if (e.resultPreview !== undefined) sc.resultPreview = e.resultPreview;
        if (e.costUsd !== undefined) { sc.costUsd = (sc.costUsd ?? 0) + e.costUsd; this.totals.costUsd += e.costUsd; }
        if (e.tokens !== undefined) { sc.tokens = (sc.tokens ?? 0) + e.tokens; this.totals.tokens += e.tokens; }
      }),
    ];
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
  }
}

// ── Tool factory ──

export interface ReplToolDeps {
  sandboxManager: SandboxManager;
  smartModel: Model<Api>;
  workerModel: Model<Api>;
  registry: ModelRegistry;
  config: RlmConfig;
  signal?: AbortSignal;
  onUsage?: (usage: Usage, role: "sub") => void;
}

export function createReplTool(deps: ReplToolDeps): ToolDefinition<typeof ReplToolParams, ReplDetails> {
  const { sandboxManager, workerModel, registry, config, signal, onUsage } = deps;
  const bridgeState = new NativeBridgeState();

  // Build handlers once — llm/rlm use mutable refs, interactive is session-stable
  const llmHandlers = bridgeState.buildLlmHandlers({
    workerModel, registry,
    maxPromptChars: config.maxPromptChars,
    maxConcurrent: config.maxConcurrentSubcalls,
    sampling: config.subSampling,
    signal,
  });

  // Real recursive rlm_query via createEngine — each call spawns a child RLM
  // with its own sandbox and turn loop, not a flat one-shot llm_query.
  const rlmHandlers = bridgeState.buildRlmHandlers({
    smartModel: deps.smartModel,
    workerModel,
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

    async execute(_toolCallId, rawParams, _execSignal, _onUpdate, ctx) {
      if (!Value.Check(ReplToolParams, rawParams)) {
        const errors = [...Value.Errors(ReplToolParams, rawParams)]
          .map((e) => `${e.instancePath}: ${e.message}`).join("; ");
        return {
          content: [{ type: "text", text: `Invalid REPL parameters: ${errors}` }],
          details: { status: "error", output: "", stderr: errors, executionTimeMs: 0, subcalls: [], totals: { costUsd: 0, tokens: 0 } },
        };
      }
      const params = rawParams;

      const emitter = new RlmEmitter();
      const collector = new SubcallCollector(emitter);
      const limits = new LimitGuard({
        maxBudgetUsd: config.maxBudgetUsd,
        maxTimeoutMs: config.maxTimeoutMs,
        maxTokens: config.maxTokens,
        maxErrors: config.maxErrors,
      });

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
        // Wire per-invocation mutable state for sandbox handlers
        bridgeState.swap({ emitter, parentId: undefined, depth: 0, limits });

        // Build interactive handlers (session-stable callbacks)
        const interactive = createPiInteractiveDeps(ctx);
        const interactiveHandlers = buildInteractiveHandlers({
          onAskUserQuestion: config.askUserQuestion ? interactive.onAskUserQuestion : undefined,
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
        const result: ReplResult = await sandboxManager.exec(params.code);
        const elapsed = Date.now() - start;

        const subUsage: Usage = {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: collector.totals.tokens,
          cost: { total: collector.totals.costUsd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        onUsage?.(subUsage, "sub");

        if (queuedId) emitter.emitSubcallUpdated({ id: queuedId, status: "done" });

        return {
          content: [{ type: "text", text: result.stdout || result.answerContent || "(no output)" }],
          details: {
            status: "done",
            output: result.stdout,
            stderr: result.stderr,
            executionTimeMs: elapsed,
            subcalls: collector.subcalls,
            totals: collector.totals,
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `REPL error: ${msg}` }],
          details: {
            status: "error",
            output: "",
            stderr: msg,
            executionTimeMs: 0,
            subcalls: collector.subcalls,
            totals: collector.totals,
          },
        };
      } finally {
        collector.dispose();
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

      const glyph = details.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const stats = details.executionTimeMs > 0 ? ` (${details.executionTimeMs}ms)` : "";

      let body = `${glyph} ${theme.fg("toolTitle", theme.bold("REPL"))}${stats}`;
      if (details.output) {
        const out = details.output.length > 500 ? `${details.output.slice(0, 500)}...` : details.output;
        body += `\n  ${theme.fg("toolOutput", out.replace(/\n/g, "\n  "))}`;
      }
      if (details.stderr) {
        body += `\n  ${theme.fg("error", details.stderr.slice(0, 200))}`;
      }
      if (expanded && details.subcalls.length > 0) {
        body += `\n  ${theme.fg("muted", `${details.subcalls.length} sub-call(s)`)}`;
      }

      return new Text(body, 0, 0);
    },
  };
}
