/**
 * runRlm — the headless RLM loop (port of rlm/core/rlm.py `completion()`).
 *
 * Each call owns a fresh sandbox, drives the *smart* model turn-by-turn over ```repl``` blocks,
 * services `llm_query`/`rlm_query` via the bridges, and stops when the model submits an answer
 * or a limit/turn cap is hit. Recursion is wired by giving the sandbox rlm handlers that call
 * back into `runRlm` at depth+1. Used for recursion and for headless/automation runs.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createFsBridge } from "../bridge/fs-tools.ts";
import { createLlmBridge } from "../bridge/llm-query.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { resolveModelId } from "../config/settings.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import { NOOP_OBSERVER, type SubcallObserver } from "../state/events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import type { AnchorEdit } from "../text/edits.ts";
import type { EditRequestPreview } from "../text/edit-preview.ts";
import { previewStdout, previewText } from "../text/preview.ts";
import { contextLength, contextTypeLabel } from "../text/tokens.ts";
import { collectEdits, finalAnswerOf, formatReplOutputs, latestAnswerContentOf, turnHadError } from "./answer.ts";
import { compactHistory, shouldCompact } from "./compaction.ts";
import { appendUserMessage } from "./history.ts";
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import type { RlmConfig, RlmInput, RlmResult, RunRlm } from "./types.ts";
import { appendRow, finalizeSnapshot, generateRunId, pruneRuns, snapshotPath, writeContextSidecar } from "../state/index.ts";
import { STATE_SCHEMA_VERSION } from "../state/rows.ts";
import type { RunHeader } from "../state/rows.ts";

export interface EngineDeps {
  smartModel: Model<Api>;
  workerModel: Model<Api>;
  registry: ModelRegistry;
  config: RlmConfig;
  limits?: Limits;
  signal?: AbortSignal;
  /** Live AgentTree reporting. Defaults to a no-op observer. */
  observer?: SubcallObserver;
  /** Called with each completion's usage (root + sub-LLM) for cost/token rollups. */
  onUsage?: (usage: Usage, role: "root" | "sub") => void;
  /** Called after propose_edit validates and before the worker records the edit. */
  onEditRequest?: (request: EditRequestPreview) => Promise<boolean>;
  /** Run-state persistence handle. undefined ⇒ persistence off. */
  runState?: { cwd: string; dir: string; snapshot: boolean };
}

/** Build a `runRlm` bound to the given deps. The returned function is reused for recursion. */
export function createEngine(deps: EngineDeps): RunRlm {
  const observer = deps.observer ?? NOOP_OBSERVER;
  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    const nowIso = (): string => new Date().toISOString(); // local helper — 4 call sites below
    const persist = input.depth === 0 && deps.runState !== undefined;
    // Compute runId early so it can tag the MLflow root span (Ops: trace correlation on resume).
    const runId = persist
      ? (input.resume ? input.resume.header.runId : generateRunId())
      : undefined;
    const selfId = observer.start({
      kind: input.depth === 0 ? "root" : "rlm",
      depth: input.depth,
      parentId: input.parentNodeId,
      model: deps.smartModel.id,
      label: input.depth === 0 ? "root" : "rlm_query",
      detail: input.rootPrompt ? input.rootPrompt.slice(0, 60) : String(input.context).slice(0, 60),
      runId,
      resume: Boolean(input.resume),
    });

    const overrideModel = input.smartModelOverride ? resolveModelId(deps.registry, input.smartModelOverride) : undefined;
    if (input.smartModelOverride && !overrideModel) {
      observer.end(selfId, { error: "unknown model override" });
      return {
        answer: `Error: unknown model override '${input.smartModelOverride}'`,
        edits: [],
        iterations: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
    }
    const smartModel = overrideModel ?? deps.smartModel;

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
      maxPromptChars: deps.config.maxPromptChars,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      sampling: deps.config.subSampling,
      signal: deps.signal,
      onUsage: (u) => {
        limits.addUsage(u);
        deps.onUsage?.(u, "sub");
      },
      observer,
      parentId: selfId,
      depth: input.depth,
    });
    const rlm = createRlmHandlers({
      run,
      llm,
      maxDepth: deps.config.maxDepth,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      parentNodeId: selfId,
      remainingBudget: () => ({
        budgetUsd: limits.remainingBudgetUsd(),
        timeoutMs: limits.remainingTimeoutMs(),
      }),
      onChildUsage: (costUsd, inputTokens, outputTokens) => {
        limits.addRaw(costUsd, inputTokens, outputTokens);
      },
      workspaceRoot: input.workspaceRoot,
    });
    let sandbox: PythonSandbox | undefined;
    let best = "";
    let lastAnswer = "";
    let compactions = 0;
    let completedTurns = 0;
    let editsAcc: ProposedEdit[] = [];
    let nodeStatus: "done" | "error" = "done";
    let persistOn = persist;
    const fsTools = Boolean(input.workspaceRoot); // B1: compute before header — `const fs` is created later in the try block
    if (persist && deps.runState && !input.resume && runId) {
      const json = typeof input.context !== "string";
      writeContextSidecar(deps.runState.cwd, deps.runState.dir, runId, input.context, json);
      const header: RunHeader = {
        kind: "header", v: STATE_SCHEMA_VERSION, runId, ts: nowIso(),
        rootPrompt: input.rootPrompt,
        context: { type: contextTypeLabel(input.context), chars: contextLength(input.context), json, projectMap: input.projectMap ?? false },
        workspaceRoot: input.workspaceRoot,
        models: { smart: smartModel.id, worker: deps.workerModel.id },
        meta: { maxIterations: deps.config.maxIterations, maxDepth: deps.config.maxDepth, orchestrator: deps.config.orchestrator, editEnabled: deps.config.editEnabled && fsTools, fsTools },
      };
      persistOn = appendRow(deps.runState.cwd, deps.runState.dir, runId, header);
      pruneRuns(deps.runState.cwd, deps.runState.dir, deps.config.runLog?.maxRuns ?? 50); // Ops: retention — prune oldest runs beyond maxRuns
    }

    const recordTerminal = (status: "completed" | "finalized" | "aborted" | "stopped", r: RlmResult): void => {
      if (!persistOn || !runId || !deps.runState) return;
      appendRow(deps.runState.cwd, deps.runState.dir, runId, {
        kind: "terminal", ts: nowIso(), status, answer: r.answer, iterations: r.iterations,
        usage: { costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
      });
    };

    try {
      const fsInitialFiles = input.projectMap && typeof input.context === "string"
        ? input.context.split("\n").filter((line) => line && !line.startsWith("#"))
        : undefined;
      const fs = input.workspaceRoot
        ? createFsBridge(input.workspaceRoot, {
            signal: deps.signal,
            initialFiles: fsInitialFiles,
            observer,
            parentId: selfId,
            depth: input.depth,
            limits: deps.config.fsLimits,
            allowReadOutsideWorkspace: deps.config.allowReadOutsideWorkspace,
          })
        : undefined;

      const editHandlers = fs && deps.config.editEnabled && input.depth === 0
        ? {
            proposeEdit: async (path: string, oldText: string, newText: string, existingEdits: readonly AnchorEdit[]) => {
              const validationPreview = await fs.proposeEdit(path, oldText, newText, existingEdits);
              if (validationPreview.startsWith("Error:")) return validationPreview;
              if (deps.config.editRequestApproval === "yolo") return validationPreview;
              const approved = await deps.onEditRequest?.({ path, oldText, newText, validationPreview }) ?? false;
              return approved ? validationPreview : "Error: edit request declined by user";
            },
          }
        : {};
      sandbox = await PythonSandbox.spawn({
        depth: input.depth,
        execTimeoutS: deps.config.execTimeoutS,
        requestTimeoutMs: deps.config.requestTimeoutMs,
        python: deps.config.python,
        signal: deps.signal,
        workspaceRoot: input.workspaceRoot,
        initTimeoutMs: deps.config.sandboxInitTimeoutMs,
        handlers: { ...llm, ...rlm, ...(fs ? { readFile: fs.readFile, grep: fs.grep, find: fs.find } : {}), ...editHandlers },
      });

      const meta = {
        contextType: contextTypeLabel(input.context),
        contextChars: contextLength(input.context),
        rootPrompt: input.rootPrompt || undefined,
        workspaceRoot: input.workspaceRoot,
        fsTools: Boolean(fs),
        projectMap: input.projectMap ?? false,
      };
      const system = buildRlmSystemPrompt(meta, {
        orchestrator: deps.config.orchestrator,
        recursion: input.depth + 1 < deps.config.maxDepth,
        edit: Boolean(fs) && deps.config.editEnabled && input.depth === 0,
      });
      let history: ChatMsg[] = input.resume ? input.resume.history : [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined = input.resume?.pendingReplOutputs;
      const startTurn = input.resume?.completedTurns ?? 0;
      if (input.resume) {
        limits.addRaw(input.resume.usageSeed.costUsd, input.resume.usageSeed.inputTokens, input.resume.usageSeed.outputTokens);
        best = input.resume.best;
        editsAcc = [...input.resume.editsAcc];
        compactions = input.resume.compactions;
        completedTurns = input.resume.completedTurns;
      }
      await sandbox.loadContext(input.context);
      if (input.resume?.snapshotTurn !== undefined && deps.runState && runId) // R-C1: restore from the verified per-turn file
        await sandbox.restore(snapshotPath(deps.runState.cwd, deps.runState.dir, runId, input.resume.snapshotTurn));
      for (let i = startTurn; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        observer.detail(selfId, `turn ${i + 1}/${deps.config.maxIterations}`);

        if (pendingReplOutputs) {
          appendUserMessage(history, pendingReplOutputs);
          pendingReplOutputs = undefined;
        }

        if (deps.config.compaction) {
          const compactionDeps = {
            model: smartModel,
            registry: deps.registry,
            contextWindow: smartModel.contextWindow,
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
              appendRow(deps.runState.cwd, deps.runState.dir, runId, {
                kind: "compaction", turn: i + 1, ts: nowIso(), history,
                usage: compactionUsage,
              });
            }
          }
        }

        appendUserMessage(history, buildTurnPrompt(i, deps.config.maxIterations));

        const turn = await runTurn(history, sandbox, {
          model: smartModel,
          registry: deps.registry,
          sampling: { reasoning: deps.config.smartReasoning },
          signal: deps.signal,
        });
        const allBlocks = turn.blocks.length > 0
          ? turn.blocks.map((b) => previewText(b, 400)).join("\n")
          : previewText(turn.response, 400);
        observer.action(selfId, `▶ ${allBlocks}`);
        observer.result(selfId, previewStdout(turn.results));
        limits.addUsage(turn.usage);
        observer.usage(selfId, turn.usage.cost.total, turn.usage.totalTokens);
        deps.onUsage?.(turn.usage, "root");
        const answerContent = latestAnswerContentOf(turn.results);
        if (answerContent) best = answerContent;
        else if (!best && turn.response.trim()) best = turn.response;
        completedTurns = i + 1;
        const proposedEdits = collectEdits(turn.results);
        if (proposedEdits.length > 0) editsAcc = proposedEdits;

        const final = finalAnswerOf(turn.results);
        if (final != null) {
          const done = result(final, i + 1, limits, editsAcc);
          recordTerminal("completed", done);
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        const turnReplOutputs = formatReplOutputs(turn.results);
        pendingReplOutputs = turnReplOutputs;

        if (persistOn && runId && deps.runState) {
          const pklPath = snapshotPath(deps.runState.cwd, deps.runState.dir, runId, i + 1); // R-C1: per-turn file
          // QA: snapshot() already catches internally and returns false — no IIFE needed.
          const snapOk = deps.runState.snapshot && sandbox
            ? await sandbox.snapshot(pklPath)
            : false;
          const ok = appendRow(deps.runState.cwd, deps.runState.dir, runId, {
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
          else if (snapOk) finalizeSnapshot(pklPath); // B4: rename .tmp → .pkl only after the trail row is durable
        }
      }
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      const finalized = result(await finalize(history, deps, limits), deps.config.maxIterations, limits);
      recordTerminal("finalized", finalized);
      lastAnswer = finalized.answer;
      return finalized;
    } catch (err) {
      // Abort is a user action — resolve with the best partial, not an error.
      if (deps.signal?.aborted) {
        const aborted = result(best.trim() || "(aborted)", completedTurns, limits);
        recordTerminal("aborted", aborted);
        lastAnswer = aborted.answer;
        return aborted;
      }
      if (err instanceof LimitError) {
        nodeStatus = "error";
        const stopped = result(best.trim() || `(stopped: ${err.message})`, completedTurns, limits);
        recordTerminal("stopped", stopped);
        lastAnswer = stopped.answer;
        return stopped;
      }
      nodeStatus = "error";
      throw err;
    } finally {
      observer.end(selfId, nodeStatus === "error" ? { error: "stopped" } : { resultPreview: previewText(lastAnswer) });
      await sandbox?.dispose();
    }
  };
  return run;
}

function result(answer: string, iterations: number, limits: LimitGuard, edits: ProposedEdit[] = []): RlmResult {
  const u = limits.usage();
  return { answer, edits, iterations, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs };
}

/** Out of turns: ask the model for its best final answer (plain text). */
async function finalize(history: ChatMsg[], deps: EngineDeps, limits: LimitGuard): Promise<string> {
  const finalHistory = [...history];
  appendUserMessage(finalHistory, FINALIZE_PROMPT);
  const { text, usage } = await modelComplete(finalHistory, {
    model: deps.smartModel,
    registry: deps.registry,
    reasoning: deps.config.smartReasoning,
    signal: deps.signal,
  });
  limits.addUsage(usage);
  return text.trim();
}
