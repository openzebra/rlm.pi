/**
 * repl() tool — executes Python code in the persistent RLM sandbox.
 *
 * Registered as a Pi tool so the main agent can use `repl({code: "..."})` alongside
 * its normal tool suite. Each call creates a fresh RlmEmitter for sub-call tracking
 * and collects sub-calls manually from emitter events. No RlmEventAggregator is used
 * (ReplDetails ≠ RlmDetails structural mismatch).
 *
 * Sub-call handling itself lives in bridge/subcall-handlers.ts; this file only supplies the
 * per-invocation Invocation those handlers resolve against, swapping it inside the
 * serialized exec slot so a queued repl() cannot claim the running one's emitter.
 *
 * Work started with `spawn()` may still be running when the call returns, so it resolves to
 * the session-scoped BackgroundTasks registry instead and is drained back into whichever
 * turn is reporting next.
 */

import { Type } from "typebox";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Model, Usage, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildInteractiveHandlers } from "../bridge/interactive.ts";
import { buildLibraryHandler } from "../bridge/library.ts";
import { libraryPrefixesIn } from "../context/library-context.ts";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import type { SubcallGates } from "../util/concurrency.ts";
import { LimitGuard, limitsFromConfig } from "../core/limits.ts";
import type { InteractiveDeps, RlmConfig, RlmInput, RlmResult } from "../core/types.ts";
import { SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { SubcallOpts } from "../sandbox/sandbox.ts";
import { createSubcallHandlers, type Invocation } from "../bridge/subcall-handlers.ts";
import { BackgroundTasks } from "./background-tasks.ts";
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
import { attachTracer, trace, traceEnabled } from "../util/trace.ts";

/** Chars of code shown on the tool call line, and of stdout in the expanded view. */
const CALL_PREVIEW_CHARS = 80;
const EXPANDED_STDOUT_CHARS = 2_000;
const EXPANDED_STDERR_CHARS = 500;

// ── Parameter schema ──

export const ReplToolParams = Object.freeze(Type.Object({
  code: Type.String({ description: "Python code to execute in the persistent REPL sandbox" }),
}));

/** Last non-empty line of a Python traceback — the `TypeError: …` line, not the frames. */
function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.slice(0, 200);
  }
  return "";
}

/** Model-visible text assembled from a repl() result. */
export interface ReplResultText {
  readonly text: string;
}

/**
 * Assemble the model-visible text for a repl() result: cap stdout, append a zero-subcall
 * delegation nudge when a bulk read went undelegated, and report tasks still running.
 *
 * The pending line is the model's only signal that `spawn()`ed work is outstanding — without
 * it a model that spawned and moved on has no way to know it should still collect.
 *
 * `varNames` covers the opposite failure: a block that stores its results in `answers` and
 * prints nothing reads as a bare "(no output)", so the model concludes the block did nothing
 * and re-runs it — paying twice for the same sub-calls. The headless engine already answers
 * this with the same hint (core/answer.ts); native mode was the only path missing it.
 */
export function buildReplResultText(
  stdout: string,
  finalAnswer: string | undefined,
  subcalls: readonly RlmSubcall[],
  backgroundPending = 0,
  varNames: readonly string[] = [],
): ReplResultText {
  const answerSubmitted = finalAnswer !== undefined;
  const noOutput = !answerSubmitted && !stdout;
  const varsHint = noOutput && varNames.length > 0
    ? ` — the block ran fine and these REPL vars are defined: ${varNames.join(", ")}. `
      + "Do NOT re-run it; read them in the next block."
    : "";
  const rawText = answerSubmitted
    ? `ANSWER_SUBMITTED (${finalAnswer.length} chars) — delivered to user. Do not restate it.`
    : stdout || `(no output)${varsHint}`;
  // Model-visible text is capped; the caller keeps full stdout in `details` for the TUI.
  const cappedText = capReplResultText(rawText) ?? rawText;
  const delegated = subcalls.some((s) => s.kind === "llm" || s.kind === "batch" || s.kind === "rlm");
  const nudge = answerSubmitted ? undefined : replDelegationNudge(rawText.length, delegated);
  const failedBg = subcalls.filter((s) => s.id.startsWith("bg") && s.status === "error").length;
  const pendingLine = backgroundPending > 0
    ? `\n\n[rlm] ${backgroundPending} background task(s) still running — rlm_await_all(tasks) to collect.`
    : "";
  const failedLine = failedBg > 0
    ? `\n[rlm] ${failedBg} background sub-call(s) FAILED — their rlm_await value is an "Error: …" string, not data.`
    : "";
  return { text: cappedText + (nudge ?? "") + pendingLine + failedLine };
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
 * Holds per-invocation state that the sandbox handlers resolve against.
 *
 * The sandbox is created once, so the tool swaps the current Invocation between repl()
 * calls rather than rebuilding handlers (which would lose REPL variable state). Handlers
 * capture the Invocation synchronously at interrupt entry and never re-read it — with
 * spawn() a sub-call can outlive its exec, and a later read would attribute it to whichever
 * turn happened to be current when it resumed.
 *
 * Detached work resolves to the session-scoped background Invocation instead, whose emitter
 * and LimitGuard are not torn down at the end of a turn.
 */
class NativeBridgeState {
  private current: Invocation | null = null;
  /** Interactive callbacks for the turn in progress; child engines inherit them. */
  interactive: InteractiveDeps | null = null;

  constructor(private readonly background: BackgroundTasks) {}

  swap(inv: Invocation, interactive: InteractiveDeps): void {
    this.current = Object.freeze({ ...inv });
    this.interactive = interactive;
  }

  /** Detached ⇒ session registry; otherwise the turn that is currently executing. */
  resolve(opts: SubcallOpts): Invocation | null {
    return opts.detached ? this.background.invocation : this.current;
  }

  /** The turn emitter, for library-load reporting. Null between repl() calls. */
  get currentEmitter(): RlmEmitter | null {
    return this.current?.emitter ?? null;
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
  /** Session-wide sub-call admission, shared with every child engine this tool spawns. */
  readonly gates: SubcallGates;
  /** Session-scoped home for detached spawn() work. */
  readonly background: BackgroundTasks;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
  readonly ensureContext?: () => Promise<void>;
  /** Register a reset hook for sandbox death/dispose (e.g. load_library slot counter). */
  readonly registerDiscardHook?: (reset: () => void) => void;
}

export function createReplTool(deps: ReplToolDeps): ToolDefinition<typeof ReplToolParams, ReplDetails> {
  const { sandboxManager, workerModel, registry, getConfig, signal, onUsage, background } = deps;
  const bridgeState = new NativeBridgeState(background);

  // Late-bound cwd — getOrCreate installs handlers only at spawn; never rebuild the closure.
  let sessionCwd = process.cwd();

  const getWorkerModel = (): Model<Api> => deps.getWorkerModel?.() ?? workerModel;
  const getModel = (): Model<Api> => deps.getModel?.() ?? deps.model;

  // Each rlm_query spawns a child RLM with its own sandbox and turn loop, not a flat
  // one-shot llm_query. The engine is created per call so the child's subcalls, turn
  // progress and cost deltas land on the emitter the parent invocation is using.
  const runChild = (input: RlmInput, inv: Invocation): Promise<RlmResult> => createEngine({
    model: getModel(),
    workerModel: getWorkerModel(),
    registry,
    config: getConfig(),
    signal,
    gates: deps.gates,
    // Same emitter the parent subcall node lives on — see SubcallHandlerDeps.runChild.
    emitter: inv.emitter,
    // Everything a child engine spends is sub-work from this tool's perspective, including
    // the child's own root turns — so fold both roles into "sub" rather than casting.
    onUsage: onUsage === undefined ? undefined : (usage: Usage) => onUsage(usage, "sub"),
    limits: limitsFromConfig(getConfig()),
    onTodo: bridgeState.interactive?.onTodo,
    onAskUserQuestion: bridgeState.interactive?.onAskUserQuestion,
  })(input);

  // Built once: the same closures stay correct across repl() calls because everything
  // per-invocation is reached through bridgeState.resolve, not captured here.
  const subcallHandlers = createSubcallHandlers({
    resolve: (opts) => bridgeState.resolve(opts),
    gates: deps.gates,
    registry,
    getWorkerModel,
    getModel,
    getConfig,
    signal,
    onUsage,
    runChild,
    // The session sandbox's context is the child's world. Read lazily so a load_library from an
    // earlier repl() reaches a child spawned in a later one. Populated before any interrupt can
    // fire: execute() awaits ensureContext() before getOrCreate().
    getChildContext: () => sandboxManager.contextPayload ?? undefined,
    trackDetached: (task) => background.track(task),
  });

  const libraryBundle = getConfig().libraryLoader
    ? buildLibraryHandler({
        getCwd: () => sessionCwd,
        getEmitter: () => bridgeState.currentEmitter,
        // Refuse pre-flight whatever the worker would reject, so host idempotency is never
        // committed for an append that did not happen.
        getContext: () => sandboxManager.contextPayload,
        parentId: undefined,
        signal,
        startIndex: 1,
        // Keep the manager's replay copy in step with the worker's live `context`, and with it
        // whatever a child spawned after this load will inherit.
        onLoaded: (_index, payload) => { sandboxManager.appendLibrary(payload); },
      })
    : undefined;
  if (libraryBundle) {
    // Re-derive the loaded-prefix cache from the payload that will actually be replayed —
    // clearing it outright would make the host re-clone a library the recreated worker already has.
    const bundle = libraryBundle;
    deps.registerDiscardHook?.(() => bundle.reset(libraryPrefixesIn(sandboxManager.contextPayload)));
  }

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

    async execute(_toolCallId, rawParams, execSignal, onUpdate, ctx) {
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

      const detachTracers = traceEnabled
        ? [attachTracer(emitter, "turn"), attachTracer(background.emitter, "background")]
        : [];

      // ── Progressive rendering: spinner + live sub-call tree ──
      const progress = createProgressNotifier<ReplDetails>({
        onUpdate,
        getDetails: () => {
          // Detached spawn() nodes live on the SESSION emitter, so without this merge the card
          // stays empty for the entire time background work is running.
          const live = background.liveSubcalls();
          const bg = background.liveTotals();
          const own = store.getTotals();
          return {
            status: progressStatus,
            output: capturedStdout,
            stderr: capturedStderr,
            executionTimeMs: Date.now() - startedAt,
            subcalls: live.length > 0 ? [...store.getSubcalls(), ...live] : store.getSubcalls(),
            totals: { costUsd: own.costUsd + bg.costUsd, tokens: own.tokens + bg.tokens },
            backgroundPending: background.pending > 0 ? background.pending : undefined,
          };
        },
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
          ...subcallHandlers,
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

        if (traceEnabled) {
          trace("repl.exec.start", { chars: params.code.length, code: params.code.slice(0, 400) });
        }

        const start = Date.now();
        const result: ReplResult = await sandboxManager.execWithSetup(params.code, () => {
          // Wire per-invocation mutable state only after the serialized exec slot
          // is active. Swapping earlier would let queued repl() calls overwrite
          // emitter/limits for the currently running REPL execution.
          bridgeState.swap({ emitter, parentId: undefined, depth: 0, limits }, interactive);
        }, execSignal);
        const elapsed = Date.now() - start;
        capturedStdout = result.stdout;
        capturedStderr = result.stderr;
        progressStatus = "done";

        if (traceEnabled) {
          trace("repl.exec.end", {
            ms: elapsed,
            stdout: result.stdout.length,
            raised: result.raised,
            pending: background.pending,
            // A block that raised delegated nothing; without the exception the trace shows a
            // silent turn and the reason is only in the TUI card.
            error: result.raised ? lastLine(result.stderr) : undefined,
          });
        }

        // Adopt every background subtree that has settled, whether or not this turn awaited
        // it — otherwise a spawn the model never collects would never reach the user's cost
        // totals. IDs are "bg"-prefixed, so they cannot collide with this turn's.
        // (drain() removes what it hands over, so live view + accounted view never double-count.)
        const adopted = background.drain();
        const subcalls: readonly RlmSubcall[] = adopted.subcalls.length > 0
          ? [...store.getSubcalls(), ...adopted.subcalls]
          : store.getSubcalls();
        const totals = {
          costUsd: store.getTotals().costUsd + adopted.totals.costUsd,
          tokens: store.getTotals().tokens + adopted.totals.tokens,
        };
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
          subcalls,
          background.pending,
          result.varNames,
        );

        const details: ReplDetails = {
          status: "done",
          output: result.stdout,
          stderr: result.stderr,
          executionTimeMs: elapsed,
          subcalls,
          totals,
          finalAnswer,
          backgroundPending: background.pending > 0 ? background.pending : undefined,
          warnings: collectReplWarnings(subcalls),
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
        // Drain here too: a failing turn must not swallow the cost of background work that
        // settled during it, or a run that keeps erroring would never report any of it.
        const adopted = background.drain();
        const details: ReplDetails = {
          status: "error",
          output: "",
          stderr: msg,
          executionTimeMs: 0,
          subcalls: [...store.getSubcalls(), ...adopted.subcalls],
          totals: {
            costUsd: store.getTotals().costUsd + adopted.totals.costUsd,
            tokens: store.getTotals().tokens + adopted.totals.tokens,
          },
          backgroundPending: background.pending > 0 ? background.pending : undefined,
        };
        onUpdate?.({ content: [{ type: "text", text: `REPL error: ${msg}` }], details });
        return {
          content: [{ type: "text", text: `REPL error: ${msg}` }],
          details,
        };
      } finally {
        progress.stop();
        for (const off of detachTracers) off();
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
  return cardStatsLine(details.totals, theme, elapsed, details.backgroundPending);
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
