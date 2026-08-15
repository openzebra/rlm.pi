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
import { buildAddContextHandler } from "../bridge/add-context.ts";
import { mergeIntoContext } from "../context/merge.ts";
import {
  createSubcallHandlers,
  createTaskRegistry,
  type Invocation,
} from "../bridge/handlers/index.ts";
import { TaskLedger, contextSig, taskKey } from "./ledger.ts";
import { type MemoryStore, rootContextPaths } from "./memory.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import { pinContext, type PinnedContext } from "../sandbox/context-file.ts";
import { previewStdout, previewText } from "../text/preview.ts";
import { contextLength, contextSizeStats, contextTypeLabel } from "../text/tokens.ts";
import { finalAnswerOf, formatReplOutputs, latestAnswerContentOf, turnHadError } from "./answer.ts";
import { compactHistory, elideOldToolPayloads, shouldCompact } from "./compaction.ts";
import { appendUserMessage } from "./history.ts";
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import { continuationPrompt, distillTrajectory, resolveBudget, WRAP_UP_BUDGET } from "./budget.ts";
import { ModelContextRegistry, modelsCachePath } from "./model-registry.ts";
import type { RlmConfig, RlmInput, RlmResult, RunRlm, Sampling } from "./types.ts";
import { createSubcallGates, type SubcallGates } from "../util/concurrency.ts";

/**
 * Grace period for detached sub-calls to settle before the run disposes its sandbox.
 * Past it the abort signal (or process exit) is what stops them; waiting longer would
 * hold a finished run open on work whose result nobody can receive.
 */
const DETACHED_SETTLE_MS = 5_000;
/** H6 (audit): root episodes snapshot at most this many real files — replay invalidation for
 *  the disk-backed slice of the context without hashing an unbounded repository. */
const ROOT_HASH_MAX = 64;


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
  /** v5: session-wide durable memory store (`.rlm/`); omitted → memory off for this engine. */
  readonly memory?: MemoryStore;
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

    const model = deps.model;

    // Create LimitGuard BEFORE the bridge so sub-LLM usage feeds into it.
    // Children inherit the parent's remaining timeout (propagated as remaining amount, not
    // the full original cap).
    const limits = new LimitGuard({
      maxTimeoutMs: input.remainingTimeoutMs ?? deps.limits?.maxTimeoutMs,
      maxErrors: deps.limits?.maxErrors,
      maxTokens: deps.limits?.maxTokens,
    });

    // v5 token budget: the primary run-length control. A continuation run carries its own
    // budget in `input.budget`; a fresh run resolves one from the model's context window.
    // ONE registry per run (audit M1): shared by budget resolution, and observed when the
    // model metadata already knows the window so the disk cache populates for other callers.
    const modelCtxRegistry = new ModelContextRegistry(modelsCachePath(runCwd));
    const budget =
      input.budget ??
      (deps.config.enableTokenBudget
        ? resolveBudget(contextWindowOrFallback(model, modelCtxRegistry), deps.config)
        : undefined);

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
    // One registry per run — unawaited task reminders share the same map as await handlers.
    const taskRegistry = createTaskRegistry();
    // v5 TaskLedger: one blackboard per root run; children inherit the same instance via
    // childRun (RlmInput.ledger — the one construction seam, DRY #6).
    const runLedger = input.ledger ?? new TaskLedger();
    if (deps.config.enableLedger) runLedger.beginRun(input.rootPrompt);

    // v5 durable memory: read-only root replay — an identical prompt over an identical
    // context answers for zero API calls (measured 10,051 → 0 tok in rlm_test).
    const rootMemory =
      deps.memory !== undefined && deps.config.enableMemory ? deps.memory : undefined;
    const modelRefStr = `${model.provider}/${model.id}`;
    const rootKey = taskKey("root", input.rootPrompt, [], modelRefStr, contextSig(input.context));
    if (rootMemory !== undefined && input.depth === 0 && input.budget === undefined) {
      const hit = rootMemory.replay(rootKey);
      if (hit !== undefined) {
        emitter.emitStatus("done");
        return {
          answer: hit.result,
          iterations: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        };
      }
    }
    const persistRoot = (
      answer: string,
      spend?: { readonly inputTokens: number; readonly outputTokens: number },
    ): void => {
      if (rootMemory === undefined || input.depth !== 0) return;
      // H2 (audit): only clean root runs persist — a continuation leaf carries the ORIGINAL
      // run's key (it persists the chain itself), and stopped/aborted partials must never
      // replay as if they were real answers.
      if (input.budget !== undefined) return;
      if (answer === "" || answer === "(aborted)" || answer.startsWith("(stopped")) return;
      const u = spend ?? limits.usage();
      rootMemory.recordEpisode({
        key: rootKey,
        kind: "root",
        model: modelRefStr,
        prompt: input.rootPrompt,
        paths: rootContextPaths(input.context, ROOT_HASH_MAX),
        result: answer,
        tokensIn: u.inputTokens,
        tokensOut: u.outputTokens,
      });
    };

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
      // Read lazily: a source added on turn 3 must reach a child spawned on turn 4. Safe
      // despite being wired before liveContext is assigned — children can only spawn from an
      // interrupt during runTurn, which is strictly after loadContext below.
      getChildContext: () => liveContext,
      ledger: runLedger,
      memory: rootMemory,
      trackDetached: async (task) => {
        detachedInFlight += 1;
        try {
          return await task();
        } finally {
          detachedInFlight -= 1;
          if (detachedInFlight === 0) detachedIdle?.();
        }
      },
    }, taskRegistry);
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
     * This run's live context: whatever was seeded plus every source added so far. Children
     * inherit it, so it must grow when add_context appends (see the handler's onLoaded below).
     *
     * Run-scoped on purpose — recursion means N of these are live at once, and a module-level
     * "current context" would hand a depth-3 child its cousin's world.
     */
    let liveContext: unknown = [];
    /**
     * This run's hold on the serialized context file. Kept for the whole run so every child that
     * inherits the same payload reuses one file instead of re-serializing the repository.
     */
    let contextPin: PinnedContext | undefined;
    /** Re-pin after the payload changes identity (mergeIntoContext returns a new array). */
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
    // v5 budget cascade state: the wrap-up note fires for exactly ONE turn after crossing soft.
    let softFired = false;
    let softNoteTurn = -1;

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
        contextLoader: deps.config.contextLoader,
        child: input.depth > 0,
        delegation: input.depth > 0 && deps.config.childSurface === "delegation",
        depth: input.depth,
      });

      // v5 (audit M5): a delegation child does not grow the world — add_context stays root-only.
      const contextHandlers =
        deps.config.contextLoader && (input.depth === 0 || deps.config.childSurface !== "delegation")
        ? buildAddContextHandler({
            cwd: runCwd,
            emitter,
            parentId: selfReportId,
            signal: deps.signal,
            getContext: () => liveContext,
            onLoaded: async (payload) => {
              // The accumulator is what children inherit, which is what makes inheritance
              // transitive — grandchildren see the source too.
              liveContext = mergeIntoContext(liveContext, payload);
              await repinLiveContext();
            },
          }).handlers
        : {};

      sandbox = await PythonSandbox.spawn({
        depth: input.depth,
        surface: input.depth > 0 && deps.config.childSurface === "delegation" ? "child" : "root",
        execTimeoutS: deps.config.execTimeoutS,
        requestTimeoutMs: deps.config.requestTimeoutMs,
        python: deps.config.python,
        signal: deps.signal,
        initTimeoutMs: deps.config.sandboxInitTimeoutMs,
        maxPromptChars: deps.config.maxPromptChars,
        awaitTimeoutS: Math.round(deps.config.requestTimeoutMs / 1000),
        handlers: {
          ...subcalls,
          ...contextHandlers,
          ledgerClaims: () => Promise.resolve(runLedger.listClaims()),
          memoryOp: (op, args) => Promise.resolve(rootMemory?.serviceOp(op, args) ?? "memory off"),
        },
      });

      let history: ChatMsg[] = [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined;

      // Context is already a sandbox-ready list (or a raw string for text children).
      liveContext = input.context ?? [];
      contextPin = await pinContext(liveContext);
      await sandbox.loadContextPinned(contextPin);
      for (let i = 0; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, detail: `turn ${i + 1}/${deps.config.maxIterations}` });
        else emitter.emitTurn(i + 1, deps.config.maxIterations);

        if (deps.config.compaction) {
          // v5 G1 first: elide old tool payloads head+tail — often avoids the summary entirely.
          history = elideOldToolPayloads(history);
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

        // Soft runtime nudge (rlm_test parity): remind the model to await pending host tasks.
        const pendingIds = taskRegistry.awaitDeps.unawaitedIds();
        if (pendingIds.length > 0) {
          appendUserMessage(
            history,
            `[runtime] Unawaited task_ids: ${pendingIds.join(", ")} — call await before finish.`,
          );
        }

        // v5 [ledger] blackboard + [memory] notes — each silent ("") when it has nothing to say.
        const ledgerBlock = deps.config.enableLedger ? runLedger.injectBlock() : "";
        const memoryBlock = rootMemory !== undefined ? rootMemory.injectBlock(input.rootPrompt) : "";
        const notes =
          [
            i === softNoteTurn ? WRAP_UP_BUDGET : undefined,
            ledgerBlock === "" ? undefined : ledgerBlock,
            memoryBlock === "" ? undefined : memoryBlock,
          ]
            .filter((s): s is string => s !== undefined)
            .join("\n\n") || undefined;
        appendUserMessage(history, buildTurnPrompt(i, deps.config.maxIterations, notes));

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
          persistRoot(done.answer);
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        pendingReplOutputs = formatReplOutputs(turn.results, turn.skippedBlocks);

        // ── v5 budget cascade ─────────────────────────────────────────────────────
        // Content control lives here; wall-clock timeouts stay hang backstops. Whole-tree
        // tokens (root + sub-LLM) reach `limits` through the invocation's addUsage/addRaw seams.
        if (budget !== undefined) {
          const u = limits.usage();
          budget.observeTotal(u.inputTokens, u.outputTokens);
          const bstate = budget.state();
          if (bstate === "soft" && !softFired) {
            softFired = true;
            softNoteTurn = i + 1;
            if (selfReportId) {
              emitter.emitSubcallUpdated({ id: selfReportId, detail: `budget soft @ ${u.inputTokens + u.outputTokens}/${budget.soft} tok` });
            }
          }
          if (bstate === "hard") {
            if (budget.canContinue()) {
              // Distill the trajectory and chain a fresh run with a fresh spend window —
              // the v4 "finalize NOW" flaw fix: never abort mid-task, restructure-and-resume.
              const handoff = distillTrajectory(history, input.rootPrompt, deps.config.budgetHandoffChars);
              const cont = budget.nextContinuation();
              if (selfReportId) {
                emitter.emitSubcallUpdated({ id: selfReportId, detail: `budget hard → continuation ${cont.continuations}` });
              }
              const inner = await run({
                ...input,
                rootPrompt: continuationPrompt(cont.continuations, handoff),
                context: liveContext, // H9: sources added mid-run reach the leaf
                budget: cont,
                remainingTimeoutMs: limits.remainingTimeoutMs(),
              });
              // H9: report the CHAIN's spend, not just the leaf's fresh guard.
              const u = limits.usage();
              const chained: RlmResult = {
                ...inner,
                iterations: inner.iterations + completedTurns,
                inputTokens: inner.inputTokens + u.inputTokens,
                outputTokens: inner.outputTokens + u.outputTokens,
                costUsd: inner.costUsd + u.costUsd,
              };
              // H2: the ORIGINAL run persists the chain's answer under the ORIGINAL key —
              // the next identical prompt must replay the full result, not miss.
              // R2: lastAnswer must be set before return — `finally` emitAnswer reads it,
              // and persist must store the CHAIN totals, not just the parent window.
              lastAnswer = chained.answer;
              persistRoot(chained.answer, chained);
              return chained;
            }
            // Chain cap reached — finalize with the best partial (a budget never throws).
            break;
          }
        }
      }
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      const finalized = result(await finalize(history, model, deps, limits), deps.config.maxIterations, limits);
      persistRoot(finalized.answer);
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
      if (deps.config.enableLedger) runLedger.endRun();
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

/** Model metadata window, else the offline registry fallback (disk cache → table → 32k). */
/** Model metadata window, else the offline registry fallback (disk cache → table → 32k).
 *  When metadata provides the window it is observed into the cache (fail-soft, audit M1). */
function contextWindowOrFallback(model: Model<Api>, registry: ModelContextRegistry): number {
  if (model.contextWindow !== undefined && model.contextWindow > 0) {
    registry.observe(`${model.provider}/${model.id}`, model.contextWindow);
    return model.contextWindow;
  }
  return registry.limitFor(`${model.provider}/${model.id}`);
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
