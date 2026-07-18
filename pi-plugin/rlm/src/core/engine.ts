/**
 * runRlm — the headless RLM loop (port of rlm/core/rlm.py `completion()`).
 *
 * Each call owns a fresh sandbox, drives the root model turn-by-turn over ```repl``` blocks,
 * services `llm_query`/`rlm_query` via the bridges, and stops when the model submits an answer
 * or a limit/turn cap is hit. Recursion is wired by giving the sandbox rlm handlers that call
 * back into `runRlm` at depth+1. Used for recursion and for headless/automation runs.
 *
 * When `config.pipeline` is on at depth 0: goal capture, artifact-gated advance_phase,
 * serial implement fanout via child RLMs, history reset at phase boundaries, and
 * measured validate→blueprint corrective routing.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { buildLibraryHandler } from "../bridge/library.ts";
import { createLlmBridge } from "../bridge/llm-query.ts";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { resolveModelId } from "../config/settings.ts";
import { buildRlmSystemPrompt } from "../prompts/system.ts";
import { buildTurnPrompt, FINALIZE_PROMPT } from "../prompts/user.ts";
import { buildImplementPhasePrompt, phaseGuidance } from "../prompts/phases.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import {
  advancePhase as validatePhaseTransition,
  initialPhaseState,
  phaseGatePrompt,
  routeAfterValidate,
  stageForArtifactKind,
  STAGES,
  type Phase,
  type PhaseState,
  type StageGateData,
} from "./pipeline.ts";
import type { PlanGateData, ValidationGateData } from "./gates.ts";
import { captureGoal, readArtifact, saveArtifact, type GoalCapture } from "./artifacts.ts";
import { previewStdout, previewText } from "../text/preview.ts";
import { applyProposedEdits } from "../text/edits.ts";
import { contextLength, contextSizeStats, contextTypeLabel } from "../text/tokens.ts";
import { collectEdits, finalAnswerOf, formatReplOutputs, latestAnswerContentOf, turnHadError } from "./answer.ts";
import { compactHistory, shouldCompact } from "./compaction.ts";
import { appendUserMessage } from "./history.ts";
import { runTurn } from "./iteration.ts";
import { type Limits, LimitError, LimitGuard } from "./limits.ts";
import type { InteractiveDeps, RlmConfig, RlmInput, RlmResult, RunRlm, Sampling } from "./types.ts";
import { randomUUID } from "node:crypto";
import {
  appendRow,
  appendTodoRow,
  generateRunId,
  pruneRuns,
  readLibrarySidecars,
  snapshotPath,
  writeContextSidecar,
} from "../state/index.ts";
import { STATE_SCHEMA_VERSION } from "../state/rows.ts";
import type { PhaseRow, RunHeader } from "../state/rows.ts";
import { serializeForSandbox, type ContextBundle } from "../context/repomix-context.ts";
import type { ProposedEdit } from "../sandbox/protocol.ts";
import { formatError, isErrorText } from "../util/errors.ts";


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
  /** Test-only: override model completion (scripted multi-turn responses). */
  readonly complete?: import("./iteration.ts").CompleteFn;
}

/** Optional payload for a fresh-session history reset at a phase boundary. */
export interface PhaseHistoryOptions {
  readonly goal?: GoalCapture;
  readonly validation?: ValidationGateData;
  /** Fanout summary embedded so implement-exit result survives the history wipe. */
  readonly implementSummary?: string;
  /** Engine notice folded into the first user message (no console I/O). */
  readonly notice?: string;
}

/**
 * Fresh-session policy: at each phase boundary the conversation is replaced;
 * artifacts (paths) are the only channel. REPL variables persist — the transition
 * message tells the model context survives in the sandbox, not in chat.
 */
export function resetHistoryForPhase(
  system: string,
  state: PhaseState,
  options: PhaseHistoryOptions = {},
): ChatMsg[] {
  const { goal, validation, implementSummary, notice } = options;
  const parts: string[] = [
    `You are entering the '${state.current}' phase.`,
  ];
  if (notice) parts.push(notice);
  if (goal) {
    parts.push(`The user's verbatim brief: read ${goal.goalPath} from the REPL (open()).`);
    parts.push(`Pre-run dirty baseline (exclude from delta judgment): ${goal.baselinePath}`);
  }
  for (const [p, path] of Object.entries(state.artifacts)) {
    if (path !== undefined) parts.push(`Artifact from '${p}': ${path}`);
  }
  if (validation) {
    parts.push(
      `Previous validation found ${validation.blockersCount} blocker(s) — read the validation artifact and address every blocker in the revised plan.`,
    );
  }
  if (implementSummary) {
    parts.push("Implement fanout result:", implementSummary);
  }
  parts.push(phaseGuidance(state.current));
  parts.push("Your REPL variables persist; the chat history was reset to keep your window small.");
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/** Build a `runRlm` bound to the given deps. The returned function is reused for recursion. */
export function createEngine(deps: EngineDeps): RunRlm {
  const { emitter } = deps;
  const run: RunRlm = async (input: RlmInput): Promise<RlmResult> => {
    const nowIso = (): string => new Date().toISOString(); // local helper — 4 call sites below
    const persist = input.depth === 0 && deps.runState !== undefined;
    const runCwd = deps.runState?.cwd ?? process.cwd();
    // Compute runId early for run-state correlation on resume.
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
    const remainingBudget = (): { readonly budgetUsd?: number; readonly timeoutMs?: number } => ({
      budgetUsd: limits.remainingBudgetUsd(),
      timeoutMs: limits.remainingTimeoutMs(),
    });

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
      remainingBudget,
    });
    const rlm = createRlmHandlers({
      run,
      llm,
      emitter,
      maxDepth: deps.config.maxDepth,
      maxConcurrent: deps.config.maxConcurrentSubcalls,
      parentNodeId: selfReportId,
      remainingBudget,
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
    let phaseState: PhaseState | undefined;
    let lastSavedArtifact: Partial<Record<Phase, string>> = {};
    /** Serviced ask_user_question rounds in the current phase (session-only; reset on transition). */
    let askRoundsThisPhase = 0;
    let pendingHistoryReset: ChatMsg[] | undefined;
    let goal: GoalCapture | undefined;
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
          meta: { maxIterations: deps.config.maxIterations, maxDepth: deps.config.maxDepth, orchestrator: deps.config.orchestrator, pipeline: deps.config.pipeline },
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

    const persistPhaseRow = async (
      state: PhaseState,
      artifactPath: string | undefined,
      artifactPhase: Phase | undefined,
      gateData: StageGateData | undefined,
    ): Promise<void> => {
      if (!persistOn || !runId || !deps.runState) return;
      const row: PhaseRow = {
        kind: "phase",
        turn: completedTurns + 1,
        ts: nowIso(),
        phase: state.current,
        summary: state.summary,
        artifactPath,
        artifactPhase,
        blockersCount: gateData?.kind === "validation" ? gateData.validation.blockersCount : undefined,
        backwardJumps: state.backwardJumps,
      };
      const ok = await appendRow(deps.runState.cwd, deps.runState.dir, runId, row);
      if (!ok) persistOn = false;
    };

    /** Clear lastSaved entries so a re-entered stage cannot re-gate with a stale artifact. */
    const clearLastSaved = (...phases: readonly Phase[]): void => {
      const next: Partial<Record<Phase, string>> = { ...lastSavedArtifact };
      for (const p of phases) delete next[p];
      lastSavedArtifact = next;
    };

    const runImplementFanout = async (planPath: string, plan: PlanGateData): Promise<string> => {
      // Fanout children need a real RLM (sandbox + stage_edit); depth-cap degradation is a no-op.
      if (input.depth + 1 >= deps.config.maxDepth) {
        return formatError(
          `implement fanout requires maxDepth >= ${input.depth + 2} so child RLMs can run (current maxDepth=${deps.config.maxDepth})`,
        );
      }
      const lines = new Array<string>(plan.phases.length);
      for (let i = 0; i < plan.phases.length; i++) {
        const r = plan.phases[i];
        if (r === undefined) continue;
        // Keep the root sandbox's exec watchdog alive across long serial fanout work.
        sandbox?.refreshWatchdog();
        const prompt = buildImplementPhasePrompt(planPath, r);
        const res = await rlm.childRun({
          rootPrompt: prompt,
          context: input.context,
          depth: input.depth + 1,
          label: `implement ${r.index + 1}/${r.total}: ${r.title}`,
        });
        sandbox?.refreshWatchdog();
        // Serial patch-series: a later phase EDITS files an earlier phase CREATES —
        // apply this child's edits BEFORE the next child starts.
        const childEdits = res.edits ?? [];
        const apply = await applyProposedEdits(childEdits, runCwd);
        if (!apply.ok) {
          return formatError(`implement halted at Phase ${r.n} (${r.title}): ${apply.error}`);
        }
        if (childEdits.length > 0) {
          const next = new Array<ProposedEdit>(editsAcc.length + childEdits.length);
          for (let j = 0; j < editsAcc.length; j++) next[j] = editsAcc[j];
          for (let j = 0; j < childEdits.length; j++) next[editsAcc.length + j] = childEdits[j];
          editsAcc = next;
        }
        lines[i] = `Phase ${r.n} (${r.title}): ${apply.applied} edit(s) applied — ${previewText(res.answer, 120)}`;
        if (isErrorText(res.answer)) {
          return formatError(`implement halted at Phase ${r.n}: ${res.answer}\n${lines.slice(0, i + 1).join("\n")}`);
        }
      }
      return `ok — implement complete (${plan.phases.length} phase(s), serial):\n${lines.join("\n")}\nNow advance_phase("validate").`;
    };

    try {
      const pipelineOn = input.depth === 0 && deps.config.pipeline;
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
        pipeline: deps.config.pipeline && input.depth === 0,
        maxPromptChars: deps.config.maxPromptChars,
        libraryLoader: deps.config.libraryLoader,
      });

      const phaseHandlers = pipelineOn
        ? {
            saveArtifact: async (kind: string, content: string): Promise<string> => {
              const stage = stageForArtifactKind(kind);
              if (stage === undefined) {
                return formatError(`unknown artifact kind '${kind}' (valid: clarification, research, plan, validation)`);
              }
              const current = phaseState?.current ?? "clarify";
              if (stage.phase !== current) {
                return formatError(
                  `artifact kind '${kind}' belongs to phase '${stage.phase}', but the pipeline is in '${current}'`,
                );
              }
              const saved = saveArtifact(runCwd, stage.artifactDir, kind, content);
              if (!saved.ok) return formatError(saved.error);
              lastSavedArtifact = { ...lastSavedArtifact, [stage.phase]: saved.path };
              return `ok — saved ${saved.path}. Call advance_phase when the artifact is complete (status: ready).`;
            },
            advancePhase: async (phase: string, summary: string | undefined): Promise<string> => {
              const current = phaseState?.current ?? "clarify";
              const outcome = validatePhaseTransition(current, phase);
              if (!outcome.ok) return formatError(outcome.error);

              // Clarify interview gate: engine counts serviced ask_user_question rounds
              // (un-gameable — the model cannot advance without having actually asked).
              if (current === "clarify" && askRoundsThisPhase === 0) {
                return formatError(
                  "clarify requires at least one ask_user_question round — interview the user before advancing",
                );
              }

              // GATE: measure the CURRENT stage's latest save only (never fall back to
              // phaseState.artifacts — those are completed-channel paths and may be stale
              // across a corrective loop).
              const stage = STAGES[current];
              const artifactPath = lastSavedArtifact[current];
              if (stage.artifactDir !== "" && artifactPath === undefined) {
                return formatError(
                  `phase '${current}' has no saved artifact — call save_artifact("${stage.artifactKind}", content) first`,
                );
              }
              let gateData: StageGateData | undefined;
              if (stage.artifactDir !== "" && artifactPath !== undefined) {
                const content = readArtifact(runCwd, artifactPath);
                if (!content.ok) return formatError(content.error);
                const gate = stage.gate(content.value, artifactPath, runCwd);
                if (!gate.ok) return formatError(gate.error);
                gateData = gate.value;
              }

              // Implement fanout runs BEFORE committing the transition: on failure the
              // phase stays put and the error remains visible as the advance_phase return.
              let implementSummary: string | undefined;
              if (outcome.phase === "implement" && gateData?.kind === "plan") {
                const planPath = artifactPath ?? "";
                implementSummary = await runImplementFanout(planPath, gateData.plan);
                if (isErrorText(implementSummary)) {
                  return implementSummary;
                }
              }

              // Transition accepted: persist row, schedule root history reset (fresh session).
              const prevArtifacts = phaseState?.artifacts ?? {};
              const nextArtifacts: Partial<Record<Phase, string>> = { ...prevArtifacts };
              if (artifactPath !== undefined) nextArtifacts[current] = artifactPath;
              phaseState = {
                current: outcome.phase,
                advancedAt: completedTurns,
                summary,
                artifacts: nextArtifacts,
                backwardJumps: phaseState?.backwardJumps ?? 0,
              };
              await persistPhaseRow(phaseState, artifactPath, artifactPath !== undefined ? current : undefined, gateData);
              // Leaving a stage: clear its lastSaved so a future re-entry must re-save.
              clearLastSaved(current);
              // Session-only ask counter (like lastSavedArtifact): reset on every accepted transition.
              askRoundsThisPhase = 0;
              pendingHistoryReset = resetHistoryForPhase(system, phaseState, {
                goal,
                implementSummary,
              });

              if (implementSummary !== undefined) {
                return implementSummary;
              }
              const prevLabel = `was '${current}'`;
              return `ok — phase advanced to '${outcome.phase}' (${prevLabel}${summary ? `, summary: ${summary.slice(0, 80)}` : ""})`;
            },
          }
        : {};
      const baseAsk = deps.config.askUserQuestion ? deps.onAskUserQuestion : undefined;
      const interactiveHandlers = buildInteractiveHandlers({
        onAskUserQuestion: baseAsk
          ? async (questions) => {
              const answers = await baseAsk(questions);
              // Count only successfully serviced root-depth rounds (handler already rejects depth>0).
              askRoundsThisPhase++;
              return answers;
            }
          : undefined,
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

      const restoredSlots = input.resume && deps.runState && runId
        ? await readLibrarySidecars(deps.runState.cwd, deps.runState.dir, runId)
        : [];
      const libraryHandlers = deps.config.libraryLoader
        ? buildLibraryHandler({
            cwd: runCwd,
            emitter,
            parentId: selfReportId,
            signal: deps.signal,
            startIndex: 1 + restoredSlots.reduce((m, s) => Math.max(m, s.index), 0),
            onLoaded: async (index, payload) => {
              if (!persistOn || !runId || !deps.runState) return;
              await writeContextSidecar(
                deps.runState.cwd, deps.runState.dir, runId,
                payload, typeof payload !== "string", index,
              );
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
        handlers: { ...llm, ...rlm, ...phaseHandlers, ...interactiveHandlers, ...libraryHandlers },
      });

      let history: ChatMsg[] = input.resume ? input.resume.history : [{ role: "system", content: system }];
      let pendingReplOutputs: string | undefined = input.resume?.pendingReplOutputs;
      const startTurn = input.resume?.completedTurns ?? 0;
      if (input.resume) {
        limits.addRaw(input.resume.usageSeed.costUsd, input.resume.usageSeed.inputTokens, input.resume.usageSeed.outputTokens);
        best = input.resume.best;
        editsAcc = [];
        compactions = input.resume.compactions;
        completedTurns = input.resume.completedTurns;
        if (input.resume.phase) {
          const resumePhase = input.resume.phase;
          const artifacts: Partial<Record<Phase, string>> = {};
          if (resumePhase.artifacts) {
            for (const [k, v] of Object.entries(resumePhase.artifacts)) {
              if (
                v !== undefined
                && (k === "clarify" || k === "research" || k === "blueprint" || k === "implement" || k === "validate")
              ) {
                artifacts[k] = v;
              }
            }
          }
          phaseState = {
            current: resumePhase.current as Phase,
            advancedAt: resumePhase.advancedAt,
            summary: resumePhase.summary,
            artifacts,
            backwardJumps: resumePhase.backwardJumps ?? 0,
          };
          // lastSaved is session-only: never rehydrate from trail (would re-gate stale
          // plan/validation after loop-back / mid-stage resume without a fresh save).
          lastSavedArtifact = {};
          // askRoundsThisPhase is session-only (like lastSavedArtifact): a resume mid-clarify
          // restarts the interview count so the model must ask again in this process.
          askRoundsThisPhase = 0;
        }
      } else if (pipelineOn) {
        // Goal capture (script, no LLM) + seed phase state + fresh history.
        const captured = captureGoal(runCwd, input.rootPrompt);
        let goalNotice: string | undefined;
        if (captured.ok) {
          goal = captured.value;
        } else {
          // Fail-soft: fold into the first reset message (never console — corrupts TUI).
          goalNotice = `Note: goal artifact could not be written (${captured.error}); the brief remains only in the system prompt.`;
        }
        // Clarify only when interviews are enabled AND the host wired a callback.
        // Config alone is not enough: without onAskUserQuestion every ask throws and
        // the run would burn maxIterations stuck at clarify (askRounds stays 0).
        const startPhase =
          deps.config.askUserQuestion && deps.onAskUserQuestion !== undefined
            ? "clarify"
            : "research";
        phaseState = initialPhaseState(0, startPhase);
        history = resetHistoryForPhase(system, phaseState, { goal, notice: goalNotice });
      }

      // Context: serialize ContextBundle to sandbox-ready JSON array, pass raw strings through.
      const contextValue = typeof input.context === "object" && input.context !== null && "files" in input.context
        ? serializeForSandbox(input.context as ContextBundle)
        : input.context;
      await sandbox.loadContext(contextValue);
      for (const slot of restoredSlots) {
        await sandbox.loadContext(slot.payload, slot.index);   // re-injects context_N for resumed runs
      }
      if (input.resume?.snapshotTurn !== undefined && deps.runState && runId && sessionNonce) // R-C1: restore only for same-session (sessionNonce present)
        await sandbox.restore(snapshotPath(deps.runState.cwd, deps.runState.dir, runId, input.resume.snapshotTurn), sessionNonce);
      for (let i = startTurn; i < deps.config.maxIterations; i++) {
        limits.checkTimeout();
        if (selfReportId) emitter.emitSubcallUpdated({ id: selfReportId, detail: `turn ${i + 1}/${deps.config.maxIterations}` });
        else emitter.emitTurn(i + 1, deps.config.maxIterations);

        // Apply deferred history reset from a prior advance_phase (fresh session policy).
        if (pendingHistoryReset !== undefined) {
          history = pendingHistoryReset;
          pendingHistoryReset = undefined;
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

        if (pendingReplOutputs) {
          appendUserMessage(history, pendingReplOutputs);
          pendingReplOutputs = undefined;
        }

        const gateMsg = deps.config.pipeline ? phaseGatePrompt(phaseState, completedTurns) : undefined;
        const gateUserMsg = gateMsg ? `[${new Date().toISOString()}] ${gateMsg}` : undefined;
        // Phase guidance lives only in resetHistoryForPhase (fresh session) — do not re-inject
        // into every turn prompt (avoids duplication on turn 1 and dead post-transition flags).
        appendUserMessage(
          history,
          buildTurnPrompt(i, deps.config.maxIterations, gateUserMsg),
        );

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
        const proposedEdits = collectEdits(turn.results);
        if (proposedEdits.length > 0) editsAcc = proposedEdits;
        const final = finalAnswerOf(turn.results);
        if (final != null) {
          // Validate-phase finalize: measure THIS turn's validation save only (lastSaved),
          // never fall back to phaseState.artifacts (stale after a prior loop).
          if (pipelineOn && phaseState?.current === "validate") {
            const vPath = lastSavedArtifact.validate;
            if (vPath === undefined) {
              // Reject finalize — push error into next turn.
              history.push({ role: "assistant", content: turn.response });
              pendingReplOutputs = formatError(
                "finalize rejected — save the validation artifact first via save_artifact(\"validation\", content) with status: ready, blockers_count, and verdict",
              );
              continue;
            }
            const content = readArtifact(runCwd, vPath);
            if (!content.ok) {
              history.push({ role: "assistant", content: turn.response });
              pendingReplOutputs = formatError(content.error);
              continue;
            }
            const gate = STAGES.validate.gate(content.value, vPath, runCwd);
            if (!gate.ok) {
              history.push({ role: "assistant", content: turn.response });
              pendingReplOutputs = formatError(gate.error);
              continue;
            }
            if (gate.value.kind !== "validation") {
              history.push({ role: "assistant", content: turn.response });
              pendingReplOutputs = formatError("internal: validate gate did not return validation data");
              continue;
            }
            const validation = gate.value.validation;
            const route = routeAfterValidate(
              validation,
              phaseState.backwardJumps,
              deps.config.maxBackwardJumps,
            );
            if (route.kind === "loop-back") {
              // Keep clarify/research; record validate for the reset message; DROP blueprint so
              // the model must write a new plan. Clear lastSaved so gates cannot re-use
              // round-1 plan/validation without a fresh save_artifact.
              const nextArtifacts: Partial<Record<Phase, string>> = {
                clarify: phaseState.artifacts.clarify,
                research: phaseState.artifacts.research,
                validate: vPath,
              };
              phaseState = {
                current: "blueprint",
                advancedAt: completedTurns,
                summary: `loop-back: ${validation.blockersCount} blocker(s)`,
                artifacts: nextArtifacts,
                backwardJumps: phaseState.backwardJumps + 1,
              };
              await persistPhaseRow(phaseState, vPath, "validate", gate.value);
              clearLastSaved("blueprint", "validate");
              askRoundsThisPhase = 0;
              history = resetHistoryForPhase(system, phaseState, { goal, validation });
              pendingReplOutputs = undefined;
              pendingHistoryReset = undefined;
              continue;
            }
            if (route.kind === "halt") {
              const report = `${route.reason}\n\n${final}`;
              const halted = result(report, i + 1, limits, editsAcc);
              await recordTerminal("completed", halted);
              lastAnswer = halted.answer;
              return halted;
            }
            // route.kind === "done" — accept final answer
          }
          const done = result(final, i + 1, limits, editsAcc);
          await recordTerminal("completed", done);
          lastAnswer = done.answer;
          return done;
        }

        limits.observe(turnHadError(turn.results));
        // Always capture this turn's REPL outputs for the JSONL trail (fidelity).
        const turnReplOutputs = formatReplOutputs(turn.results, turn.skippedBlocks);
        // If advance_phase scheduled a history reset, apply it now (do not pollute fresh history).
        if (pendingHistoryReset !== undefined) {
          history = pendingHistoryReset;
          pendingHistoryReset = undefined;
          // Fanout/advance result is already embedded in the reset user message — do not
          // also append raw REPL stdout as a next-turn user message.
          pendingReplOutputs = undefined;
        } else {
          history.push({ role: "assistant", content: turn.response });
          pendingReplOutputs = turnReplOutputs;
        }

        if (persistOn && runId && deps.runState) {
          const pklPath = snapshotPath(deps.runState.cwd, deps.runState.dir, runId, i + 1);
          const snapOk = deps.runState.snapshot && sandbox && sessionNonce
            ? await sandbox.snapshot(pklPath, sessionNonce)
            : false;
          const ok = await appendRow(deps.runState.cwd, deps.runState.dir, runId, {
            kind: "turn", turn: i + 1, ts: nowIso(),
            response: turn.response,
            // Trail keeps the real REPL output even when history was reset (issue #9).
            replOutputs: turnReplOutputs || undefined,
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
      const finalized = result(await finalize(history, model, deps, limits), deps.config.maxIterations, limits, editsAcc);
      await recordTerminal("finalized", finalized);
      lastAnswer = finalized.answer;
      return finalized;
    } catch (err) {
      // Abort is a user action — resolve with the best partial, not an error.
      if (deps.signal?.aborted) {
        const aborted = result(best.trim() || "(aborted)", completedTurns, limits, editsAcc);
        await recordTerminal("aborted", aborted);
        lastAnswer = aborted.answer;
        return aborted;
      }
      if (err instanceof LimitError) {
        nodeStatus = "error";
        const stopped = result(best.trim() || `(stopped: ${err.message})`, completedTurns, limits, editsAcc);
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

function result(answer: string, iterations: number, limits: LimitGuard, edits: ProposedEdit[] = []): RlmResult {
  const u = limits.usage();
  return { answer, edits, iterations, costUsd: u.costUsd, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: u.durationMs };
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
