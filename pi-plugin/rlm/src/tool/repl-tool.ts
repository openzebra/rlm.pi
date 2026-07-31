/**
 * repl() tool — executes Python code in the persistent RLM sandbox.
 *
 * Registered as a Pi tool so the main agent can use `repl({code: "..."})` alongside
 * its normal tool suite. Each call creates a fresh RlmEmitter for sub-call tracking
 * and collects sub-calls manually from emitter events. No RlmEventAggregator is used
 * (ReplDetails ≠ RlmDetails structural mismatch).
 *
 * Sandbox handlers (llm_query, rlm_query, todo, ask_user_question) are the *shared* bridges
 * from bridge/llm-query.ts and bridge/rlm-query.ts, bound to NativeBridgeState accessors so
 * the tool can swap per-invocation state (emitter, depth, limits) without recreating the
 * sandbox — preserving REPL variable state across calls.
 */

import { Type } from "typebox";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Model, Usage, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { displayModelRef } from "../config/settings.ts";
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { buildLibraryHandler } from "../bridge/library.ts";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import { createLlmBridge } from "../bridge/llm-query.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { LimitGuard, limitsFromConfig } from "../core/limits.ts";
import type { RemainingResources } from "../core/resource-limits.ts";
import type { InteractiveDeps, RlmConfig, RunRlm } from "../core/types.ts";
import { SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import { RlmEmitter } from "./rlm-events.ts";
import { SubcallStore } from "./subcall-store.ts";
import type { ReplDetails } from "./repl-details.ts";
import type { RlmSubcall } from "./rlm-details.ts";
import { createEngine } from "../core/engine.ts";
import { spinnerFrame } from "../ui/theme.ts";
import { previewText } from "../text/preview.ts";
import { errorMessage } from "../util/errors.ts";
import {
  cardHeader,
  cardStatsLine,
  renderCollapsedCard,
  renderExpandedSubcallTree,
} from "./subcall-render.ts";
import { createProgressNotifier, validateToolParams } from "./tool-utils.ts";
import { capReplResultText, replDelegationNudge } from "../mode/native-guards.ts";

/** Chars of code shown on the tool call line, and of stdout in the expanded view. */
const CALL_PREVIEW_CHARS = 80;
const EXPANDED_STDOUT_CHARS = 2_000;
const EXPANDED_STDERR_CHARS = 500;

// ── Parameter schema ──

export const ReplToolParams = Object.freeze(Type.Object({
  code: Type.String({ description: "Python code to execute in the persistent REPL sandbox" }),
}));

/** Model-visible text assembled from a repl() result. */
export interface ReplResultText {
  readonly text: string;
}

/**
 * Assemble the model-visible text for a repl() result: cap stdout and append a
 * zero-subcall delegation nudge when a bulk read went undelegated.
 */
export function buildReplResultText(
  stdout: string,
  finalAnswer: string | undefined,
  subcalls: readonly RlmSubcall[],
): ReplResultText {
  const answerSubmitted = finalAnswer !== undefined;
  const rawText = answerSubmitted
    ? `ANSWER_SUBMITTED (${finalAnswer.length} chars) — delivered to user. Do not restate it.`
    : stdout || "(no output)";
  // Model-visible text is capped; the caller keeps full stdout in `details` for the TUI.
  const cappedText = capReplResultText(rawText) ?? rawText;
  const delegated = subcalls.some((s) => s.kind === "llm" || s.kind === "batch" || s.kind === "rlm");
  const nudge = answerSubmitted ? undefined : replDelegationNudge(rawText.length, delegated);
  return { text: cappedText + (nudge ?? "") };
}

/** Advisory diagnostics derived from a completed invocation's sub-calls. */
export function collectReplWarnings(subcalls: readonly RlmSubcall[]): readonly string[] | undefined {
  let failed = 0;
  let total = 0;
  for (let i = 0; i < subcalls.length; i++) {
    const call = subcalls[i];
    if (call.status !== "error") continue;
    // A batch subcall stands for many prompts; a single call stands for one.
    failed += call.failedCount ?? 1;
    total += call.totalCount ?? 1;
  }
  if (failed === 0) return undefined;
  return Object.freeze([`${failed}/${total} sub-call(s) failed — results may be incomplete`]);
}

// ── Mutable bridge state (handler indirection) ──

/**
 * Holds per-invocation mutable state that the shared bridges dereference through accessors.
 * The sandbox is created once with handlers bound to this object, so the tool can swap
 * emitter/depth/limits between calls without recreating the sandbox (preserving REPL state).
 */
class NativeBridgeState {
  currentEmitter: RlmEmitter | null = null;
  currentParentId: string | undefined;
  currentDepth = 0;
  currentLimits: LimitGuard | null = null;
  currentInteractive: InteractiveDeps | null = null;

  swap(inv: { emitter: RlmEmitter; parentId?: string; depth: number; limits: LimitGuard; interactive: InteractiveDeps }): void {
    this.currentEmitter = inv.emitter;
    this.currentParentId = inv.parentId;
    this.currentDepth = inv.depth;
    this.currentLimits = inv.limits;
    this.currentInteractive = inv.interactive;
  }

  /** Remaining budget/timeout of the invocation that currently owns the exec slot. */
  remainingBudget(): RemainingResources | undefined {
    const limits = this.currentLimits;
    if (!limits) return undefined;
    return { budgetUsd: limits.remainingBudgetUsd(), timeoutMs: limits.remainingTimeoutMs() };
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
  /** Live accessor — `/rlm-config` replaces the config object, so never capture the value. */
  readonly getConfig: () => RlmConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
  readonly ensureContext?: () => Promise<void>;
  /** Register a reset hook for sandbox death/dispose (e.g. load_library slot counter). */
  readonly registerDiscardHook?: (reset: () => void) => void;
}

export function createReplTool(deps: ReplToolDeps): ToolDefinition<typeof ReplToolParams, ReplDetails> {
  const { sandboxManager, workerModel, registry, getConfig, signal, onUsage } = deps;
  const bridgeState = new NativeBridgeState();

  // Late-bound cwd — getOrCreate installs handlers only at spawn; never rebuild the closure.
  let sessionCwd = process.cwd();

  const rootModel = (): Model<Api> => deps.getModel?.() ?? deps.model;

  // Build handlers once — llm/rlm/library read late-bound state so the same closures stay
  // correct across repl() calls; counters reset when the sandbox is discarded and re-spawned.
  const llmHandlers = createLlmBridge({
    workerModel: () => deps.getWorkerModel?.() ?? workerModel,
    registry,
    config: getConfig,
    signal,
    onUsage: (usage) => { bridgeState.currentLimits?.addUsage(usage); },
    remainingBudget: () => bridgeState.remainingBudget(),
    emitter: () => bridgeState.currentEmitter ?? undefined,
    parentId: () => bridgeState.currentParentId,
    depth: () => bridgeState.currentDepth,
  });

  // Real recursive rlm_query — each call spawns a child RLM with its own sandbox and turn
  // loop, bound to the *current* invocation's emitter so child sub-calls, turn progress, and
  // cost deltas land on the live visual tree.
  const runChildRlm: RunRlm = (input) => {
    const emitter = bridgeState.currentEmitter;
    // Only reachable while an invocation owns the exec slot, which always swaps in an emitter.
    if (!emitter) throw new Error("RLM bridge not wired for this invocation");
    const config = getConfig();
    return createEngine({
      model: rootModel(),
      workerModel: deps.getWorkerModel?.() ?? workerModel,
      registry,
      config,
      signal,
      emitter,
      onUsage: onUsage === undefined ? undefined : (usage, role) => { if (role === "sub") onUsage(usage, role); },
      limits: limitsFromConfig(config),
      onTodo: bridgeState.currentInteractive?.onTodo,
      onAskUserQuestion: bridgeState.currentInteractive?.onAskUserQuestion,
    })(input);
  };

  const rlmHandlers = createRlmHandlers({
    run: runChildRlm,
    llm: llmHandlers,
    config: getConfig,
    modelLabel: (override) => displayModelRef(registry, override, rootModel()),
    emitter: () => bridgeState.currentEmitter ?? undefined,
    parentNodeId: () => bridgeState.currentParentId,
    remainingBudget: () => bridgeState.remainingBudget(),
    onChildUsage: (costUsd, inputTokens, outputTokens) => {
      bridgeState.currentLimits?.addRaw(costUsd, inputTokens, outputTokens);
    },
  });

  const libraryBundle = getConfig().libraryLoader
    ? buildLibraryHandler({
        getCwd: () => sessionCwd,
        getEmitter: () => bridgeState.currentEmitter,
        parentId: undefined,
        signal,
        startIndex: 1,
      })
    : undefined;
  if (libraryBundle) deps.registerDiscardHook?.(libraryBundle.reset);

  return {
    name: "repl",
    label: "REPL",
    description:
      "PRIMARY tool for ALL repository reading and analysis (read/grep are disabled in RLM mode). " +
      "Persistent Python sandbox with every file pre-loaded in `context`. Locate first with the " +
      "free primitives search(query) / grep_context(pattern) / outline(path), then delegate the " +
      "semantic reading to map_files / llm_query / llm_query_batched / llm_query_chunked " +
      "(rlm_query for iterative sub-tasks) — stdout returned to you is hard-capped at 4K chars, " +
      "so printing file bodies is useless. Variables, imports, and the `answers`/`plan` memo " +
      "persist across calls. Also supports todo, ask_user_question, and load_library.",
    promptSnippet:
      "repl: run Python in a persistent sandbox holding the whole repository in `context`; " +
      "search/grep_context/outline to locate, map_files/llm_query* to read.",
    promptGuidelines: [
      "In RLM mode, read the repository through `repl` only — `read`/`grep` and bash readers are blocked.",
      "Inside `repl`, locate with search()/grep_context()/outline() before delegating bulk reading to map_files()/llm_query_batched().",
    ],
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
      const limits = new LimitGuard(limitsFromConfig(getConfig()));

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
          onAskUserQuestion: getConfig().askUserQuestion ? interactive.onAskUserQuestion : undefined,
          onTodo: interactive.onTodo,
          onTodoRow: undefined,
          emitter,
          depth: 0,
          parentId: undefined,
        });

        sessionCwd = ctx.cwd ?? process.cwd();

        await deps.ensureContext?.();
        await sandboxManager.getOrCreate({
          ...llmHandlers,
          ...rlmHandlers,
          askUserQuestion: interactiveHandlers.askUserQuestion,
          todo: interactiveHandlers.todo,
          ...(libraryBundle?.handlers ?? {}),
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
          bridgeState.swap({ emitter, parentId: undefined, depth: 0, limits, interactive });
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

        const finalAnswer = result.finalAnswer ?? undefined;
        const { text: resultText } = buildReplResultText(
          result.stdout,
          finalAnswer,
          store.getSubcalls(),
        );

        const details: ReplDetails = {
          status: "done",
          output: result.stdout,
          stderr: result.stderr,
          executionTimeMs: elapsed,
          subcalls: store.getSubcalls(),
          totals: store.getTotals(),
          finalAnswer,
          warnings: collectReplWarnings(store.getSubcalls()),
        };
        const progressText = finalAnswer !== undefined
          ? `ANSWER_SUBMITTED (${finalAnswer.length} chars)`
          : result.stdout.slice(0, 500) || "(no output)";
        // Final progressive update
        onUpdate?.({ content: [{ type: "text", text: progressText }], details });
        return { content: [{ type: "text", text: resultText }], details };
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
      return new Text(
        theme.fg("toolTitle", theme.bold("repl ")) + theme.fg("dim", previewText(args.code, CALL_PREVIEW_CHARS)),
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

function replStats(details: ReplDetails, theme: Theme): string {
  const elapsed = details.executionTimeMs > 0 ? `${details.executionTimeMs}ms` : undefined;
  return cardStatsLine(details.totals, theme, elapsed);
}

function renderReplCollapsed(details: ReplDetails, theme: Theme): Text {
  return renderCollapsedCard("REPL", details.status, replStats(details, theme), details.subcalls, theme);
}

// ── Expanded view ──

function renderReplExpanded(details: ReplDetails, theme: Theme): Container {
  const container = new Container();

  container.addChild(new Text(cardHeader("REPL", details.status, replStats(details, theme), theme), 0, 0));

  // Output
  if (details.output) {
    container.addChild(new Spacer(1));
    const out = details.output.length > EXPANDED_STDOUT_CHARS
      ? `${details.output.slice(0, EXPANDED_STDOUT_CHARS)}…`
      : details.output;
    container.addChild(new Text(out, 0, 0));
  }

  if (details.warnings && details.warnings.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", details.warnings.join("\n")), 0, 0));
  }

  // Stderr
  if (details.stderr) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", details.stderr.slice(0, EXPANDED_STDERR_CHARS)), 0, 0));
  }

  // Sub-call tree
  if (details.subcalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));
    container.addChild(renderExpandedSubcallTree(details.subcalls, theme));
  }

  return container;
}
