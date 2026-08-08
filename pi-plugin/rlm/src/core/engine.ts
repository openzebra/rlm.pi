/**
 * runRlm — the headless RLM loop (port of rlm/core/rlm.py `completion()`).
 *
 * Each call owns a fresh sandbox, drives the root model turn-by-turn over ```repl``` blocks,
 * services `llm_query`/`rlm_query` via the bridges, and stops when the model submits an answer
 * or a limit/turn cap is hit. Recursion is wired by giving the sandbox rlm handlers that call
 * back into `runRlm` at depth+1. Used for recursion and for headless/automation runs.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildLibraryHandler } from "../bridge/library.ts";
import { mergeLibraryIntoContext } from "../context/library-context.ts";
import {
  createSubcallHandlers,
  type Invocation,
} from "../bridge/subcall-handlers.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { resolveModelId } from "../config/settings.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import { pinContext, type PinnedContext } from "../sandbox/context-file.ts";
import { previewStdout, previewText } from "../text/preview.ts";
import { contextLength, contextSizeStats, contextTypeLabel } from "../text/tokens.ts";
import { finalAnswerOf, formatReplOutputs, latestAnswerContentOf, turnHadError } from "./answer.ts";
import { compactHistory, shouldCompact } from "./compaction.ts";
import { appendUserMessage } from "./history.ts";
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import type { RlmConfig, RlmInput, RlmResult, RunRlm, Sampling } from "./types.ts";
import { serializeForSandbox, type ContextBundle } from "../context/repomix-context.ts";
import { formatError } from "../util/errors.ts";
import { createSubcallGates, type SubcallGates } from "../util/concurrency.ts";

/**
 * Grace period for detached sub-calls to settle before the run disposes its sandbox.
 * Past it the abort signal (or process exit) is what stops them; waiting longer would
 * hold a finished run open on work whose result nobody can receive.
 */
const DETACHED_SETTLE_MS = 5_000;


export interface EngineDeps {
  readonly model: Model<Api>;
  readonly llmModel: Model<Api>;
  readonly registry: ModelRegistry;
  readonly config: RlmConfig;
  readonly limits?: Limits;
  /** Session-wide sub-call admission, shared with the repl() tool. Private one if omitted. */
  readonly gates?: SubcallGates;
  readonly signal?: AbortSignal;
  /** Live RlmDetails reporting via onUpdate. Required — replaces SubcallObserver. */
  readonly emitter: RlmEmitter;
  /** Called with each completion's usage (root + sub-LLM) for cost/token rollups. */
  readonly onUsage?: (usage: Usage, role: "root" | "sub") => void;
  /** Test-only: override model completion (scripted multi-turn responses). */
  readonly complete?: import("./iteration.ts").CompleteFn;
}

/** Build a `runRlm` bound to the given deps. The returned function is reused for recursion. */
export function createEngine(deps: EngineDeps): RunRlm {
  const { emitter } = deps;
  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    const runCwd = process.cwd();
    // For depth > 0, input.parentNodeId is the subcall ID created by the parent's rlm-query bridge.
    // For depth 0, input.parentNodeId is undefined — engine uses root-level bridge methods.
    const selfReportId = input.depth === 0 ? undefined : input.parentNodeId;
    if (!selfReportId) {
      emitter.emitRootPrompt(input.rootPrompt ? input.rootPrompt.slice(0, 60) : String(input.context).slice(0, 60));
      emitter.emitTurn(0, deps.config.maxIterations);
    }

    const overrideModel = input.modelOverride ? resolveModelId(deps.registry, input.modelOverride) : undefined;
    if (input.modelOverride && !overrideModel) {
      if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, status: "error", detail: "unknown model override" });
      else emitter.emitStatus("error");
      return {
        answer: formatError(`unknown model override '${input.modelOverride}'`),
        iterations: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
    }
    const model = overrideModel ?? deps.model;

    // Create LimitGuard BEFORE the bridge so sub-LLM usage feeds into it.
    // Children inherit the parent's remaining timeout (propagated as remaining amount, not
    // the full original cap).
    const limits = new LimitGuard({
      maxTimeoutMs: input.remainingTimeoutMs ?? deps.limits?.maxTimeoutMs,
      maxErrors: deps.limits?.maxErrors,
      maxTokens: deps.limits?.maxTokens,
    });

    // One Invocation for the whole run: this engine owns exactly one sandbox at one depth,
    // and its emitter and LimitGuard outlive every sub-call it services — including
    // detached ones, which is why the headless path needs no session registry.
    const invocation: Invocation = {
      emitter,
      parentId: selfReportId,
      depth: input.depth,
      limits: {
        remainingTimeoutMs: () => limits.remainingTimeoutMs(),
        addUsage: (u) => {
          limits.addUsage(u);
          deps.onUsage?.(u, "sub");
        },
        addRaw: (costUsd, inputTokens, outputTokens) => {
          limits.addRaw(costUsd, inputTokens, outputTokens);
        },
      },
    };
    // Detached work must not outlive the sandbox we dispose in `finally`: track it so the
    // run can settle or abort it first (a child engine left running would keep spending).
    let detachedInFlight = 0;
    let detachedIdle: (() => void) | undefined;
    const subcalls = createSubcallHandlers({
      resolve: () => invocation,
      gates: deps.gates
        ?? createSubcallGates(deps.config.maxConcurrentSubcalls, deps.config.maxConcurrentChildren),
      registry: deps.registry,
      getLlmModel: () => deps.llmModel,
      getModel: () => model,
      getConfig: () => deps.config,
      signal: deps.signal,
      runChild: run,
      // Read lazily: a library loaded on turn 3 must reach a child spawned on turn 4. Safe
      // despite being wired before liveContext is assigned — children can only spawn from an
      // interrupt during runTurn, which is strictly after loadContext below.
      getChildContext: () => liveContext,
      trackDetached: async (task) => {
        detachedInFlight += 1;
        try {
          return await task();
        } finally {
          detachedInFlight -= 1;
          if (detachedInFlight === 0) detachedIdle?.();
        }
      },
    });
    /** Wait (bounded) for detached work before the sandbox goes away. */
    const settleDetached = async (): Promise<void> => {
      if (detachedInFlight === 0) return;
      await new Promise<void>((resolve) => {
        detachedIdle = resolve;
        setTimeout(resolve, DETACHED_SETTLE_MS).unref?.();
      });
      detachedIdle = undefined;
    };
    let sandbox: PythonSandbox | undefined;
    /**
     * This run's live context: the repo pack plus every library loaded so far. Children inherit
     * it, so it must grow when load_library appends (see the library handler's onLoaded below).
     *
     * Run-scoped on purpose — recursion means N of these are live at once, and a module-level
     * "current context" would hand a depth-3 child its cousin's world.
     */
    let liveContext: unknown = null;
    /**
     * This run's hold on the serialized context file. Kept for the whole run so every child that
     * inherits the same payload reuses one file instead of re-serializing the repository.
     */
    let contextPin: PinnedContext | undefined;
    /** Re-pin after the payload changes identity (mergeLibraryIntoContext returns a new array). */
    const repinLiveContext = async (): Promise<void> => {
      const previous = contextPin;
      contextPin = await pinContext(liveContext);
      await previous?.release();
    };
    let best = "";
    let lastAnswer = "";
    let compactions = 0;
    let completedTurns = 0;
    let nodeStatus: "done" | "error" = "done";

    try {
      const meta = {
        contextType: contextTypeLabel(input.context),
        contextChars: contextLength(input.context),
        contextStats: contextSizeStats(input.context),
        rootPrompt: input.rootPrompt || undefined,
      };
      const system = buildRlmSystemPrompt(meta, {
        orchestrator: deps.config.orchestrator,
        recursion: input.depth + 1 < deps.config.maxDepth,
        maxPromptChars: deps.config.maxPromptChars,
        libraryLoader: deps.config.libraryLoader,
        child: input.depth > 0,
      });

      const libraryHandlers = deps.config.libraryLoader
        ? buildLibraryHandler({
            cwd: runCwd,
            emitter,
            parentId: selfReportId,
            signal: deps.signal,
            getContext: () => liveContext,
            onLoaded: async (payload) => {
              // The accumulator is what children inherit, which is what makes inheritance
              // transitive — grandchildren see the library too.
              liveContext = mergeLibraryIntoContext(liveContext, payload);
              await repinLiveContext();
            },
          }).handlers
        : {};

      sandbox = await PythonSandbox.spawn({
        depth: input.depth,
        execTimeoutS: deps.config.execTimeoutS,
        requestTimeoutMs: deps.config.requestTimeoutMs,
        python: deps.config.python,
        signal: deps.signal,
        initTimeoutMs: deps.config.sandboxInitTimeoutMs,
        maxPromptChars: deps.config.maxPromptChars,
        awaitTimeoutS: Math.round(deps.config.requestTimeoutMs / 1000),
        handlers: { ...subcalls, ...libraryHandlers },
      });

      let history: ChatMsg[] = [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined;

      // Context: serialize ContextBundle to sandbox-ready JSON array, pass raw strings through.
      liveContext =
        typeof input.context === "object" && input.context !== null && "files" in input.context
          ? serializeForSandbox(input.context as ContextBundle)
          : input.context;
      contextPin = await pinContext(liveContext);
      await sandbox.loadContextPinned(contextPin);
      for (let i = 0; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, detail: `turn ${i + 1}/${deps.config.maxIterations}` });
        else emitter.emitTurn(i + 1, deps.config.maxIterations);

        if (deps.config.compaction) {
          const compactionDeps = {
            // Summarisation is done by the cheap worker model; the threshold stays on the
            // root model's context window (that is the window the history fills each turn).
            model: deps.llmModel,
            registry: deps.registry,
            contextWindow: model.contextWindow,
            thresholdPct: deps.config.compactionThresholdPct,
            signal: deps.signal,
          };
          if (shouldCompact(history, compactionDeps)) {
            history = await compactHistory(history, compactionDeps, ++compactions, (u) => limits.addUsage(u));
          }
        }

        if (pendingReplOutputs) {
          appendUserMessage(history, pendingReplOutputs);
          pendingReplOutputs = undefined;
        }

        appendUserMessage(history, buildTurnPrompt(i, deps.config.maxIterations));

        // rootSampling fields win; smartReasoning is the default reasoning when not overridden.
        const rootSampling: Sampling = {
          reasoning: deps.config.smartReasoning,
          ...deps.config.rootSampling,
        };
        const turn = await runTurn(history, sandbox, {
          model: model,
          registry: deps.registry,
          sampling: rootSampling,
          signal: deps.signal,
          complete: deps.complete,
        });
        const allBlocks = turn.blocks.length > 0
          ? turn.blocks.map((b) => previewText(b, 400)).join("\n")
          : previewText(turn.response, 400);
        if (selfReportId) {
          emitter.emitSubcallUpdated({ id: selfReportId, args: `▶ ${allBlocks}`, resultPreview: previewStdout(turn.results) });
        }
        limits.addUsage(turn.usage);
        if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, costUsd: turn.usage.cost.total, tokens: turn.usage.totalTokens });
        else emitter.emitRootUsage(turn.usage.cost.total, turn.usage.totalTokens);
        deps.onUsage?.(turn.usage, "root");
        const answerContent = latestAnswerContentOf(turn.results);
        if (answerContent) best = answerContent;
        else if (!best && turn.response.trim()) best = turn.response;
        completedTurns = i + 1;
        const final = finalAnswerOf(turn.results);
        if (final != null) {
          const done = result(final, i + 1, limits);
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        pendingReplOutputs = formatReplOutputs(turn.results, turn.skippedBlocks);
      }
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      const finalized = result(await finalize(history, model, deps, limits), deps.config.maxIterations, limits);
      lastAnswer = finalized.answer;
      return finalized;
    } catch (err) {
      // Abort is a user action — resolve with the best partial, not an error.
      if (deps.signal?.aborted) {
        const aborted = result(best.trim() || "(aborted)", completedTurns, limits);
        lastAnswer = aborted.answer;
        return aborted;
      }
      if (err instanceof LimitError) {
        nodeStatus = "error";
        const stopped = result(best.trim() || `(stopped: ${err.message})`, completedTurns, limits);
        lastAnswer = stopped.answer;
        return stopped;
      }
      nodeStatus = "error";
      throw err;
    } finally {
      if (selfReportId) {
        emitter.emitSubcallUpdated({
          id: selfReportId,
          status: nodeStatus,
          resultPreview: nodeStatus === "error" ? undefined : previewText(lastAnswer),
          detail: nodeStatus === "error" ? "stopped" : undefined,
        });
      } else {
        if (nodeStatus !== "error" && lastAnswer) emitter.emitAnswer(previewText(lastAnswer));
        emitter.emitStatus(nodeStatus === "error" ? "error" : "done");
      }
      // Settle detached work FIRST: a child still running may be about to pin this same payload.
      await settleDetached();
      await contextPin?.release();
      await sandbox?.dispose();
    }
  };
  return run;
}

function result(answer: string, iterations: number, limits: LimitGuard): RlmResult {
  const u = limits.usage();
  return { answer, iterations, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs };
}

/** Out of turns: ask the model for its best final answer (plain text). */
async function finalize(history: ChatMsg[], model: Model<Api>, deps: EngineDeps, limits: LimitGuard): Promise<string> {
  const finalHistory = [...history];
  appendUserMessage(finalHistory, FINALIZE_PROMPT);
  const complete = deps.complete ?? modelComplete;
  const { text, usage } = await complete(finalHistory, {
    model,
    registry: deps.registry,
    reasoning: deps.config.smartReasoning,
    signal: deps.signal,
  });
  limits.addUsage(usage);
  return text.trim();
}
