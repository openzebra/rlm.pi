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
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { createLlmBridge } from "../bridge/llm-query.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { resolveModelId } from "../config/settings.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import { advancePhase as validatePhaseTransition, phaseGatePrompt, type PhaseState } from "./pipeline.ts";
import { previewStdout, previewText } from "../text/preview.ts";
import { contextLength, contextSizeStats, contextTypeLabel } from "../text/tokens.ts";
import { collectDiffs, collectEdits, finalAnswerOf, formatReplOutputs, latestAnswerContentOf, turnHadError } from "./answer.ts";
import { compactHistory, shouldCompact } from "./compaction.ts";
import { appendUserMessage } from "./history.ts";
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import type { InteractiveDeps, RlmConfig, RlmInput, RlmResult, RunRlm, Sampling } from "./types.ts";
import { randomUUID } from "node:crypto";
import { appendRow, appendTodoRow, generateRunId, pruneRuns, snapshotPath, writeContextSidecar } from "../state/index.ts";
import { STATE_SCHEMA_VERSION } from "../state/rows.ts";
import type { PhaseRow, RunHeader } from "../state/rows.ts";
import { serializeForSandbox, type ContextBundle } from "../context/repomix-context.ts";
import type { ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";
import { formatError } from "../util/errors.ts";


export interface EngineDeps extends InteractiveDeps {
  readonly model: Model<Api>;
  readonly workerModel: Model<Api>;
  readonly registry: ModelRegistry;
  readonly config: RlmConfig;
  readonly limits?: Limits;
  readonly signal?: AbortSignal;
  /** Live RlmDetails reporting via onUpdate. Required — replaces SubcallObserver. */
  readonly emitter: RlmEmitter;
  /** Called with each completion's usage (root + sub-LLM) for cost/token rollups. */
  readonly onUsage?: (usage: Usage, role: "root" | "sub") => void;
  /** Run-state persistence handle. undefined ⇒ persistence off. */
  readonly runState?: { readonly cwd: string; readonly dir: string; readonly snapshot: boolean };
}

/** Build a `runRlm` bound to the given deps. The returned function is reused for recursion. */
export function createEngine(deps: EngineDeps): RunRlm {
  const { emitter } = deps;
  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    const nowIso = (): string => new Date().toISOString(); // local helper — 4 call sites below
    const persist = input.depth === 0 && deps.runState !== undefined;
    // Compute runId early so it can tag the MLflow root span (Ops: trace correlation on resume).
    const runId = persist
      ? (input.resume ? input.resume.header.runId : generateRunId())
      : undefined;
    // I4: session-scoped pickle trust — nonce prevents cross-session snapshot replay.
    // On resume, sessionNonce is undefined → no snapshots, history-only replay.
    const sessionNonce = persist && !input.resume ? randomUUID() : undefined;
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
        edits: [],
        iterations: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
    }
    const model = overrideModel ?? deps.model;

    // Create LimitGuard BEFORE the bridge so sub-LLM usage feeds into it.
    // Children inherit the parent's remaining budget/timeout (reference: limits propagate
    // as remaining amounts, not the full original cap).
    // CA: seed the clock on resume so resumed runs don't get a fresh timeout budget.
    const limits = new LimitGuard({
      maxBudgetUsd: input.remainingBudgetUsd ?? deps.limits?.maxBudgetUsd,
      maxTimeoutMs: input.remainingTimeoutMs ?? deps.limits?.maxTimeoutMs,
      maxErrors: deps.limits?.maxErrors,
      maxTokens: deps.limits?.maxTokens,
    }, input.resume?.usageSeed.durationMs ?? 0);

    const llm = createLlmBridge({
      workerModel: deps.workerModel,
      registry: deps.registry,
      subSystem: deps.config.subSystemPrompt,
      maxPromptChars: deps.config.maxPromptChars,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      sampling: deps.config.subSampling,
      signal: deps.signal,
      onUsage: (u) => {
        limits.addUsage(u);
        deps.onUsage?.(u, "sub");
      },
      emitter,
      parentId: selfReportId,
      depth: input.depth,
    });
    const rlm = createRlmHandlers({
      run,
      llm,
      emitter,
      maxDepth: deps.config.maxDepth,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      parentNodeId: selfReportId,
      remainingBudget: () => ({
        budgetUsd: limits.remainingBudgetUsd(),
        timeoutMs: limits.remainingTimeoutMs(),
      }),
      onChildUsage: (costUsd, inputTokens, outputTokens) => {
        limits.addRaw(costUsd, inputTokens, outputTokens);
      },
    });
    let sandbox: PythonSandbox | undefined;
    let best = "";
    let lastAnswer = "";
    let compactions = 0;
    let completedTurns = 0;
    let editsAcc: ProposedEdit[] = [];
    let diffsAcc: ProposedDiffEdit[] = [];
    let phaseState: PhaseState | undefined;
    let nodeStatus: "done" | "error" = "done";
    let persistOn = persist;
    if (persist && deps.runState && !input.resume && runId) {
      const json = typeof input.context !== "string";
      const sidecarOk = await writeContextSidecar(deps.runState.cwd, deps.runState.dir, runId, input.context, json);
      if (!sidecarOk) {
        persistOn = false; // QC: skip header if sidecar failed — prevents orphan trail referencing non-existent context
      } else {
        const header: RunHeader = {
          kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: nowIso(),
          rootPrompt: input.rootPrompt,
          context: { type: contextTypeLabel(input.context), chars: contextLength(input.context), json },
          models: { model: model.id, worker: deps.workerModel.id },
          meta: { maxIterations: deps.config.maxIterations, maxDepth: deps.config.maxDepth, orchestrator: deps.config.orchestrator, pipeline: true },
        };
        persistOn = await appendRow(deps.runState.cwd, deps.runState.dir, runId, header);
      }
      await pruneRuns(deps.runState.cwd, deps.runState.dir, deps.config.runLog?.maxRuns ?? 50); // Ops: retention (always — cleanup even if sidecar failed)
    }

    const recordTerminal = async (status: "completed" | "finalized" | "aborted" | "stopped", r: RlmResult): Promise<boolean> => {
      if (!persistOn || !runId || !deps.runState) return false;
      return await appendRow(deps.runState.cwd, deps.runState.dir, runId, {
        kind: "terminal", ts: nowIso(), status, answer: r.answer, iterations: r.iterations,
        usage: { costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
      });
    };

    try {
      const phaseHandlers = input.depth === 0
        ? {
            advancePhase: async (phase: string, summary: string | undefined) => {
              const outcome = validatePhaseTransition(phaseState?.current, phase);
              if (!outcome.ok) return formatError(outcome.error);
              const previous = phaseState;
              phaseState = { current: outcome.phase, advancedAt: completedTurns, summary };
              if (persistOn && runId && deps.runState) {
                const row: PhaseRow = { kind: "phase", turn: completedTurns + 1, ts: nowIso(), phase: outcome.phase, summary };
                const ok = await appendRow(deps.runState.cwd, deps.runState.dir, runId, row);
                if (!ok) persistOn = false;
              }
              const prevLabel = previous ? `was '${previous.current}'` : "fresh run";
              return `ok — phase advanced to '${outcome.phase}' (${prevLabel}${summary ? `, summary: ${summary.slice(0, 80)}` : ""})`;
            },
          }
        : {};
      const interactiveHandlers = buildInteractiveHandlers({
        onAskUserQuestion: deps.config.askUserQuestion ? deps.onAskUserQuestion : undefined,
        onTodo: deps.config.todo ? deps.onTodo : undefined,
        onTodoRow: async (action, params, todoResult) => {
          if (!persistOn || !runId || !deps.runState) return;
          const ok = await appendTodoRow(deps.runState.cwd, deps.runState.dir, runId, {
            turn: completedTurns + 1, ts: nowIso(), action, params, result: todoResult,
          });
          if (!ok) persistOn = false;
        },
        emitter,
        depth: input.depth,
        parentId: selfReportId,
      });

      sandbox = await PythonSandbox.spawn({
        depth: input.depth,
        execTimeoutS: deps.config.execTimeoutS,
        requestTimeoutMs: deps.config.requestTimeoutMs,
        python: deps.config.python,
        signal: deps.signal,
        initTimeoutMs: deps.config.sandboxInitTimeoutMs,
        handlers: { ...llm, ...rlm, ...phaseHandlers, ...interactiveHandlers },
      });

      const meta = {
        contextType: contextTypeLabel(input.context),
        contextChars: contextLength(input.context),
        contextStats: contextSizeStats(input.context),
        rootPrompt: input.rootPrompt || undefined,
      };
      const system = buildRlmSystemPrompt(meta, {
        orchestrator: deps.config.orchestrator,
        recursion: input.depth + 1 < deps.config.maxDepth,
        askUserQuestion: deps.config.askUserQuestion && input.depth === 0,
        todo: deps.config.todo,
      });
      let history: ChatMsg[] = input.resume ? input.resume.history : [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined = input.resume?.pendingReplOutputs;
      const startTurn = input.resume?.completedTurns ?? 0;
      if (input.resume) {
        limits.addRaw(input.resume.usageSeed.costUsd, input.resume.usageSeed.inputTokens, input.resume.usageSeed.outputTokens);
        best = input.resume.best;
        editsAcc = [];
        diffsAcc = [];
        compactions = input.resume.compactions;
        completedTurns = input.resume.completedTurns;
        if (input.resume.phase) {
          const resumePhase = input.resume.phase;
          phaseState = { current: resumePhase.current as PhaseState["current"], advancedAt: resumePhase.advancedAt, summary: resumePhase.summary };
        }
      }

      // Context: serialize ContextBundle to sandbox-ready JSON array, pass raw strings through.
      const contextValue = typeof input.context === "object" && input.context !== null && "files" in input.context
        ? serializeForSandbox(input.context as ContextBundle)
        : input.context;
      await sandbox.loadContext(contextValue);
      if (input.resume?.snapshotTurn !== undefined && deps.runState && runId && sessionNonce) // R-C1: restore only for same-session (sessionNonce present)
        await sandbox.restore(snapshotPath(deps.runState.cwd, deps.runState.dir, runId, input.resume.snapshotTurn), sessionNonce);
      for (let i = startTurn; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, detail: `turn ${i + 1}/${deps.config.maxIterations}` });
        else emitter.emitTurn(i + 1, deps.config.maxIterations);

        if (pendingReplOutputs) {
          appendUserMessage(history, pendingReplOutputs);
          pendingReplOutputs = undefined;
        }

        if (deps.config.compaction) {
          const compactionDeps = {
            // Summarisation is done by the cheap worker model; the threshold stays on the
            // root model's context window (that is the window the history fills each turn).
            model: deps.workerModel,
            registry: deps.registry,
            contextWindow: model.contextWindow,
            thresholdPct: deps.config.compactionThresholdPct,
            signal: deps.signal,
          };
          if (shouldCompact(history, compactionDeps)) {
            const prevHistoryRef = history;
            let compactionUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
            history = await compactHistory(history, compactionDeps, ++compactions, (u) => {
              limits.addUsage(u);
              compactionUsage = { costUsd: compactionUsage.costUsd + u.cost.total, inputTokens: compactionUsage.inputTokens + u.input, outputTokens: compactionUsage.outputTokens + u.output }; // CC: accumulate
            });
            if (persistOn && runId && deps.runState && history !== prevHistoryRef) {
              const ok = await appendRow(deps.runState.cwd, deps.runState.dir, runId, {
                kind: "compaction", turn: i + 1, ts: nowIso(), history,
                usage: compactionUsage,
              });
              if (!ok) persistOn = false; // QC: disable persistence on first failure (match turn-row pattern)
            }
          }
        }

        const gateMsg = phaseGatePrompt(phaseState, completedTurns);
        const gateUserMsg = gateMsg ? `[${new Date().toISOString()}] ${gateMsg}` : undefined;
        appendUserMessage(history, buildTurnPrompt(i, deps.config.maxIterations, gateUserMsg));

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
        const proposedEdits = collectEdits(turn.results);
        if (proposedEdits.length > 0) editsAcc = proposedEdits;
        const proposedDiffs = collectDiffs(turn.results);
        if (proposedDiffs.length > 0) diffsAcc = proposedDiffs;

        const final = finalAnswerOf(turn.results);
        if (final != null) {
          const done = result(final, i + 1, limits, editsAcc, diffsAcc);
          await recordTerminal("completed", done);
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        const turnReplOutputs = formatReplOutputs(turn.results);
        pendingReplOutputs = turnReplOutputs;

        if (persistOn && runId && deps.runState) {
          const pklPath = snapshotPath(deps.runState.cwd, deps.runState.dir, runId, i + 1);
          const snapOk = deps.runState.snapshot && sandbox && sessionNonce
            ? await sandbox.snapshot(pklPath, sessionNonce)
            : false;
          const ok = await appendRow(deps.runState.cwd, deps.runState.dir, runId, {
            kind: "turn", turn: i + 1, ts: nowIso(),
            response: turn.response, replOutputs: turnReplOutputs || undefined,
            answerContent: answerContent || undefined,
            edits: proposedEdits.length > 0 ? proposedEdits : undefined,
            error: turnHadError(turn.results),
            usage: { costUsd: turn.usage.cost.total, inputTokens: turn.usage.input, outputTokens: turn.usage.output }, // B2: Usage has .input/.output, not .inputTokens/.outputTokens
            cumulativeDurationMs: limits.usage().durationMs, // B3: required by TurnRow, seeds LimitGuard clock on resume (CA)
            snapshotOk: snapOk,
          });
          if (!ok) persistOn = false;
          // No finalizeSnapshot — snapshot is atomic (os.rename inside worker.py)
        }
      }
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      const finalized = result(await finalize(history, deps, limits), deps.config.maxIterations, limits, editsAcc, diffsAcc);
      await recordTerminal("finalized", finalized);
      lastAnswer = finalized.answer;
      return finalized;
    } catch (err) {
      // Abort is a user action — resolve with the best partial, not an error.
      if (deps.signal?.aborted) {
        const aborted = result(best.trim() || "(aborted)", completedTurns, limits, editsAcc, diffsAcc);
        await recordTerminal("aborted", aborted);
        lastAnswer = aborted.answer;
        return aborted;
      }
      if (err instanceof LimitError) {
        nodeStatus = "error";
        const stopped = result(best.trim() || `(stopped: ${err.message})`, completedTurns, limits, editsAcc, diffsAcc);
        await recordTerminal("stopped", stopped);
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
        emitter.emitEdits(editsAcc.length > 0 ? editsAcc : []);
        emitter.emitStatus(nodeStatus === "error" ? "error" : "done");
      }
      await sandbox?.dispose();
    }
  };
  return run;
}

function result(answer: string, iterations: number, limits: LimitGuard, edits: ProposedEdit[] = [], diffs: ProposedDiffEdit[] = []): RlmResult {
  const u = limits.usage();
  return { answer, edits, diffs, iterations, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs };
}

/** Out of turns: ask the model for its best final answer (plain text). */
async function finalize(history: ChatMsg[], deps: EngineDeps, limits: LimitGuard): Promise<string> {
  const finalHistory = [...history];
  appendUserMessage(finalHistory, FINALIZE_PROMPT);
  const { text, usage } = await modelComplete(finalHistory, {
    model: deps.model,
    registry: deps.registry,
    reasoning: deps.config.smartReasoning,
    signal: deps.signal,
  });
  limits.addUsage(usage);
  return text.trim();
}
