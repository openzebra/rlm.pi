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
import { buildMetadataLine, buildRlmSystemPrompt } from "../prompts/system.ts";
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
    // One tree node per run: the orchestrator at depth 0, an `rlm` child when recursing.
    const selfId = observer.start({
      kind: input.depth === 0 ? "root" : "rlm",
      depth: input.depth,
      parentId: input.parentNodeId,
      model: deps.smartModel.id,
      label: input.depth === 0 ? "root" : "rlm_query",
      detail: input.rootPrompt ? input.rootPrompt.slice(0, 60) : String(input.context).slice(0, 60),
    });

    const llm = createLlmBridge({
      workerModel: deps.workerModel,
      registry: deps.registry,
      maxPromptChars: deps.config.maxPromptChars,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      sampling: deps.config.subSampling,
      signal: deps.signal,
      onUsage: (u) => deps.onUsage?.(u, "sub"),
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
    });

    const sandbox = await PythonSandbox.spawn({
      depth: input.depth,
      execTimeoutS: deps.config.execTimeoutS,
      requestTimeoutMs: deps.config.requestTimeoutMs,
      python: deps.config.python,
      handlers: { ...llm, ...rlm },
    });

    const limits = new LimitGuard(deps.limits);
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
    let nodeStatus: "done" | "error" = "done";
    try {
      await sandbox.loadContext(input.context);
      for (let i = 0; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        observer.detail(selfId, `turn ${i + 1}/${deps.config.maxIterations}`);

        if (deps.config.compaction) {
          const cd = { model: deps.smartModel, registry: deps.registry, contextWindow: deps.smartModel.contextWindow, thresholdPct: deps.config.compactionThresholdPct, signal: deps.signal };
          if (shouldCompact(history, cd)) history = await compactHistory(history, cd, ++compactions);
        }

        history.push({ role: "user", content: buildTurnPrompt(i, deps.config.maxIterations) });

        const turn = await runTurn(history, sandbox, {
          model: deps.smartModel,
          registry: deps.registry,
          signal: deps.signal,
        });
        limits.addUsage(turn.usage);
        observer.usage(selfId, turn.usage.cost.total, turn.usage.totalTokens);
        deps.onUsage?.(turn.usage, "root");
        if (turn.response.trim()) best = turn.response;

        const final = finalAnswerOf(turn.results);
        if (final != null) return result(final, i + 1, limits);

        limits.observe(turnHadError(turn.results));
        history.push({ role: "assistant", content: turn.response });
        history.push({ role: "user", content: formatReplOutputs(turn.results) });
      }
      return result(await finalize(history, deps), deps.config.maxIterations, limits);
    } catch (err) {
      if (err instanceof LimitError) {
        nodeStatus = "error";
        return result(best.trim() || `(stopped: ${err.message})`, 0, limits);
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
async function finalize(history: ChatMsg[], deps: EngineDeps): Promise<string> {
  const { text } = await modelComplete([...history, { role: "user", content: FINALIZE_PROMPT }], {
    model: deps.smartModel,
    registry: deps.registry,
    signal: deps.signal,
  });
  return text.trim();
}
