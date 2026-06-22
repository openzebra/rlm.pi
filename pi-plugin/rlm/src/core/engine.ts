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
import { createLlmBridge } from "../bridge/llm-query.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { resolveModelId } from "../config/settings.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import { NOOP_OBSERVER, type SubcallObserver } from "../state/events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import { contextLength, contextTypeLabel } from "../text/tokens.ts";
import { finalAnswerOf, formatReplOutputs, turnHadError } from "./answer.ts";
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
    });

    const sandbox = await PythonSandbox.spawn({
      depth: input.depth,
      execTimeoutS: deps.config.execTimeoutS,
      requestTimeoutMs: deps.config.requestTimeoutMs,
      python: deps.config.python,
      signal: deps.signal,
      handlers: { ...llm, ...rlm },
    });

    const meta = {
      contextType: contextTypeLabel(input.context),
      contextChars: contextLength(input.context),
      rootPrompt: input.rootPrompt || undefined,
    };
    const system = buildRlmSystemPrompt(meta, {
      orchestrator: deps.config.orchestrator,
      recursion: input.depth + 1 < deps.config.maxDepth,
    });
    let history: ChatMsg[] = [{ role: "system", content: system }];

    let best = "";
    let compactions = 0;
    let completedTurns = 0;
    let nodeStatus: "done" | "error" = "done";
    try {
      await sandbox.loadContext(input.context);
      for (let i = 0; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        observer.detail(selfId, `turn ${i + 1}/${deps.config.maxIterations}`);

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

        history.push({ role: "user", content: buildTurnPrompt(i, deps.config.maxIterations) });

        const turn = await runTurn(history, sandbox, {
          model: smartModel,
          registry: deps.registry,
          sampling: { reasoning: deps.config.smartReasoning },
          signal: deps.signal,
        });
        limits.addUsage(turn.usage);
        observer.usage(selfId, turn.usage.cost.total, turn.usage.totalTokens);
        deps.onUsage?.(turn.usage, "root");
        if (turn.response.trim()) best = turn.response;
        completedTurns = i + 1;

        const final = finalAnswerOf(turn.results);
        if (final != null) return result(final, i + 1, limits);

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        history.push({ role: "user", content: formatReplOutputs(turn.results) });
      }
      return result(await finalize(history, deps, limits), deps.config.maxIterations, limits);
    } catch (err) {
      // Abort is a user action — resolve with the best partial, not an error.
      if (deps.signal?.aborted) {
        return result(best.trim() || "(aborted)", completedTurns, limits);
      }
      if (err instanceof LimitError) {
        nodeStatus = "error";
        return result(best.trim() || `(stopped: ${err.message})`, completedTurns, limits);
      }
      nodeStatus = "error";
      throw err;
    } finally {
      observer.end(selfId, nodeStatus === "error" ? { error: "stopped" } : undefined);
      await sandbox.dispose();
    }
  };
  return run;
}

function result(answer: string, iterations: number, limits: LimitGuard): RlmResult {
  const u = limits.usage();
  return { answer, iterations, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs };
}

/** Out of turns: ask the model for its best final answer (plain text). */
async function finalize(history: ChatMsg[], deps: EngineDeps, limits: LimitGuard): Promise<string> {
  const { text, usage } = await modelComplete([...history, { role: "user", content: FINALIZE_PROMPT }], {
    model: deps.smartModel,
    registry: deps.registry,
    reasoning: deps.config.smartReasoning,
    signal: deps.signal,
  });
  limits.addUsage(usage);
  return text.trim();
}
