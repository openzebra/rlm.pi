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
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import type { RlmConfig, RlmInput, RlmResult, RunRlm } from "./types.ts";

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
}

/** Build a `runRlm` bound to the given deps. The returned function is reused for recursion. */
export function createEngine(deps: EngineDeps): RunRlm {
  const observer = deps.observer ?? NOOP_OBSERVER;
  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    const selfId = observer.start({
      kind: input.depth === 0 ? "root" : "rlm",
      depth: input.depth,
      parentId: input.parentNodeId,
      model: deps.smartModel.id,
      label: input.depth === 0 ? "root" : "rlm_query",
      detail: input.rootPrompt ? input.rootPrompt.slice(0, 60) : String(input.context).slice(0, 60),
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
    const limits = new LimitGuard({
      maxBudgetUsd: input.remainingBudgetUsd ?? deps.limits?.maxBudgetUsd,
      maxTimeoutMs: input.remainingTimeoutMs ?? deps.limits?.maxTimeoutMs,
      maxErrors: deps.limits?.maxErrors,
      maxTokens: deps.limits?.maxTokens,
    });

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
      let history: ChatMsg[] = [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined;
      await sandbox.loadContext(input.context);
      for (let i = 0; i < deps.config.maxIterations; i++) {
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
            history = await compactHistory(history, compactionDeps, ++compactions, (u) => limits.addUsage(u));
          }
        }

        appendUserMessage(history, buildTurnPrompt(i, deps.config.maxIterations));

        const turn = await runTurn(history, sandbox, {
          model: smartModel,
          registry: deps.registry,
          sampling: { reasoning: deps.config.smartReasoning },
          signal: deps.signal,
        });
        observer.action(selfId, `▶ ${previewText(turn.blocks[0] ?? turn.response)}`);
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
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        pendingReplOutputs = formatReplOutputs(turn.results);
      }
      if (pendingReplOutputs) appendUserMessage(history, pendingReplOutputs);
      const finalized = result(await finalize(history, deps, limits), deps.config.maxIterations, limits);
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
      observer.end(selfId, nodeStatus === "error" ? { error: "stopped" } : { resultPreview: previewText(lastAnswer) });
      await sandbox?.dispose();
    }
  };
  return run;
}

function appendUserMessage(history: ChatMsg[], content: string): void {
  const last = history.at(-1);
  if (last?.role === "user") {
    last.content = [last.content, content].join("\n\n");
    return;
  }
  history.push({ role: "user", content });
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
