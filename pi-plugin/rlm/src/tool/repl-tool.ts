/**
 * repl() tool — executes Python code in the persistent RLM sandbox.
 *
 * Registered as a Pi tool so the main agent can use `repl({code: "..."})` alongside
 * its normal tool suite. Each call creates a fresh RlmEmitter for sub-call tracking
 * and collects sub-calls manually from emitter events. No RlmEventAggregator is used
 * (ReplDetails ≠ RlmDetails structural mismatch).
 *
 * Sub-call handling lives in bridge/handlers/ (createSubcallHandlers); this file only supplies the
 * per-invocation Invocation those handlers resolve against, swapping it inside the
 * serialized exec slot so a queued repl() cannot claim the running one's emitter.
 *
 * Work started with `spawn()` may still be running when the call returns, so it resolves to
 * the session-scoped BackgroundTasks registry instead and is drained back into whichever
 * turn is reporting next.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Model, Usage, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildAddContextHandler, type AddContextHandlerBundle } from "../bridge/add-context.ts";
import { contextPrefixesIn } from "../context/namespace.ts";
import type { SubcallGates } from "../util/concurrency.ts";
import { LimitGuard, limitsFromConfig } from "../core/limits.ts";
import type { RlmConfig, RlmInput, RlmResult } from "../core/types.ts";
import { SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { SubcallOpts } from "../sandbox/sandbox.ts";
import { createSubcallHandlers, type Invocation } from "../bridge/handlers/index.ts";
import { TaskLedger } from "../core/ledger.ts";
import type { MemoryStore } from "../core/memory.ts";
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
import { createProgressNotifier, validateToolParams } from "./tool-utils.ts";
import { buildReplResultText, collectReplWarnings } from "./repl-result.ts";
import { renderReplCollapsed, renderReplExpanded } from "./repl-render.ts";
import { attachTracer, trace, traceEnabled } from "../util/trace.ts";

/** Chars of code shown on the tool call line. */
const CALL_PREVIEW_CHARS = 80;

/** Last non-empty line of a Python traceback — the `TypeError: …` line, not the frames. */
function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.slice(0, 200);
  }
  return "";
}

// ── Parameter schema ──

export const ReplToolParams = Object.freeze(Type.Object({
  code: Type.String({ description: "Python code to execute in the persistent REPL sandbox" }),
}));

// ── Mutable bridge state (handler indirection) ──

/**
 * Holds per-invocation state that the sandbox handlers resolve against.
 *
 * The sandbox is created once, so the tool swaps the current Invocation between repl()
 * calls rather than rebuilding handlers (which would lose REPL variable state). Handlers
 * capture the Invocation synchronously at interrupt entry and never re-read it — with
 * spawn() a sub-call can outlive its exec, and a later read would attribute it to whichever
 * turn happened to be current when it settled.
 *
 * Detached work resolves to the session-scoped background Invocation instead, whose emitter
 * and LimitGuard are not torn down at the end of a turn.
 */
class NativeBridgeState {
  private current: Invocation | null = null;

  constructor(private readonly background: BackgroundTasks) {}

  swap(inv: Invocation): void {
    this.current = Object.freeze({ ...inv });
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
  readonly llmModel: Model<Api>;
  readonly getModel?: () => Model<Api> | undefined;
  readonly getLlmModel?: () => Model<Api> | undefined;
  readonly registry: ModelRegistry;
  /** Live accessor — `/rlm-config` replaces the config object, so never capture the value. */
  readonly getConfig: () => RlmConfig;
  /** Session-wide sub-call admission, shared with every child engine this tool spawns. */
  readonly gates: SubcallGates;
  /** v5: live re-resolution of the session gates (provider caps change via /rlm-config without
   *  a restart). Falls back to `gates` when omitted. Read lazily per sub-call. */
  readonly resolveGates?: () => SubcallGates;
  /** Session-scoped home for detached spawn() work. */
  readonly background: BackgroundTasks;
  /** v5 durable memory (session-wide `.rlm` store); omitted → memory off for this tool. */
  readonly memory?: MemoryStore;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;
  readonly ensureContext?: () => Promise<void>;
  /** Register a reset hook for sandbox death/dispose (e.g. add_context prefix cache). */
  readonly registerDiscardHook?: (reset: () => void) => void;
  /**
   * Hands the live add_context bundle to the extension so the cwd seed can
   * markLoaded("") / markSeededCwd(abs) — without this, add_context(".") doubles the tree.
   */
  readonly registerContextBundle?: (bundle: AddContextHandlerBundle) => void;
}

export function createReplTool(deps: ReplToolDeps): ToolDefinition<typeof ReplToolParams, ReplDetails> {
  const { sandboxManager, llmModel, registry, getConfig, signal, onUsage, background } = deps;
  const bridgeState = new NativeBridgeState(background);
  // v5: one session-wide blackboard for the native repl() path — the same claim/coalesce/
  // demote logic the engine gets per run, shared by every turn and every child it spawns.
  const sessionLedger = new TaskLedger();

  // Late-bound cwd — getOrCreate installs handlers only at spawn; never rebuild the closure.
  let sessionCwd = process.cwd();

  const getLlmModel = (): Model<Api> => deps.getLlmModel?.() ?? llmModel;
  const getModel = (): Model<Api> => deps.getModel?.() ?? deps.model;
  // v5 (audit C6): resolve lazily per call so provider-cap edits via /rlm-config apply live.
  const currentGates = (): SubcallGates => deps.resolveGates?.() ?? deps.gates;

  // Each rlm_query spawns a child RLM with its own sandbox and turn loop, not a flat
  // one-shot llm_query. The engine is created per call so the child's subcalls, turn
  // progress and cost deltas land on the emitter the parent invocation is using.
  const runChild = (input: RlmInput, inv: Invocation): Promise<RlmResult> => createEngine({
    model: getModel(),
    llmModel: getLlmModel(),
    registry,
    config: getConfig(),
    signal,
    memory: deps.memory,
    gates: currentGates(),
    // Same emitter the parent subcall node lives on — see SubcallHandlerDeps.runChild.
    emitter: inv.emitter,
    // Everything a child engine spends is sub-work from this tool's perspective, including
    // the child's own root turns — so fold both roles into "sub" rather than casting.
    onUsage: onUsage === undefined ? undefined : (usage: Usage) => onUsage(usage, "sub"),
    limits: limitsFromConfig(getConfig()),
  })(input);

  // Built once: the same closures stay correct across repl() calls because everything
  // per-invocation is reached through bridgeState.resolve, not captured here.
  const subcallHandlers = createSubcallHandlers({
    resolve: (opts) => bridgeState.resolve(opts),
    // Getter, not a captured value: sub-call deps read gates lazily per call.
    get gates(): SubcallGates {
      return currentGates();
    },
    registry,
    getLlmModel,
    getModel,
    getConfig,
    signal,
    onUsage,
    runChild,
    // The session sandbox's context is the child's world. Read lazily so an add_context from an
    // earlier repl() reaches a child spawned in a later one. Populated before any interrupt can
    // fire: execute() awaits ensureContext() before getOrCreate().
    getChildContext: () => sandboxManager.contextPayload ?? undefined,
    ledger: sessionLedger,
    memory: deps.memory,
    trackDetached: (task) => background.track(task),
  });

  const contextBundle = getConfig().contextLoader
    ? buildAddContextHandler({
        getCwd: () => sessionCwd,
        getEmitter: () => bridgeState.currentEmitter,
        // Refuse pre-flight whatever the worker would reject, so host idempotency is never
        // committed for an append that did not happen.
        getContext: () => sandboxManager.contextPayload,
        parentId: undefined,
        signal,
        // Keep the manager's replay copy in step with the worker's live `context`, and with it
        // whatever a child spawned after this load will inherit.
        onLoaded: (payload) => { sandboxManager.appendContext(payload); },
      })
    : undefined;
  if (contextBundle) {
    // Re-derive the loaded-prefix cache from the payload that will actually be replayed —
    // clearing it outright would make the host re-clone a source the recreated worker already has.
    // Re-plant the cwd sentinel if the seed is still in the payload (un-prefixed files).
    const bundle = contextBundle;
    deps.registerDiscardHook?.(() => {
      const prefixes = contextPrefixesIn(sandboxManager.contextPayload);
      bundle.reset(prefixes);
      if (bundle.seededCwd() !== undefined) bundle.markLoaded("");
    });
    deps.registerContextBundle?.(contextBundle);
  }

  return {
    name: "repl",
    label: "REPL",
    description:
      "PRIMARY tool for bulk repository analysis (orchestrator). " +
      "Persistent Python sandbox: free locate with search/grep_context/outline, then ALWAYS-SPAWN " +
      "fan-out — llm_query/llm_batch/map_files/llm_query_chunked/rlm_query/rlm_batch return Task " +
      "immediately (↯bg); collect with await_task. Prefer rlm_batch for ≥2 independent multi-step " +
      "module studies; map_files/llm_batch for one-shot extracts. Fire independent Tasks first, " +
      "free work, then await — never treat Task as the answer. Stdout hard-capped ~4K (no file dumps). " +
      "`answers`/`plan` persist. add_context for external dirs/files/git/docs.",
    promptSnippet:
      "repl: free search/outline; fire rlm_batch|map_files|llm_batch as Task (BG); await_task for results.",
    promptGuidelines: [
      "Multi-area analysis: rlm_batch([...]) or map_files(paths, q); free search; await_task — not serial native read.",
      "Always-spawn tools return Task; only await_task has content. Fire-all then await; await_task() collects every still-running Task.",
      "llm_query/llm_batch have no disk — never 'Read path/to/file.ts'; use map_files or rlm_* (see context).",
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
        sessionCwd = ctx.cwd ?? process.cwd();

        await deps.ensureContext?.();
        await sandboxManager.getOrCreate({
          ...subcallHandlers,
          ...(contextBundle?.handlers ?? {}),
          ledgerClaims: () => Promise.resolve(sessionLedger.listClaims()),
          memoryOp: (op, args) => Promise.resolve(deps.memory?.serviceOp(op, args) ?? "memory off"),
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
        // v5 blackboard (audit C3): the turn's code cell is the ancestor task for echo
        // detection — a child restating what this cell asks gets a stub, mirroring the
        // engine's beginRun(input.rootPrompt). Popped in finally: detached work spawned by
        // this cell already claimed at spawn time, inside this window.
        const ledgerActive = getConfig().enableLedger;
        if (ledgerActive) sessionLedger.beginRun(params.code);
        let result: ReplResult;
        try {
          result = await sandboxManager.execWithSetup(params.code, () => {
            // Wire per-invocation mutable state only after the serialized exec slot
            // is active. Swapping earlier would let queued repl() calls overwrite
            // emitter/limits for the currently running REPL execution.
            bridgeState.swap({ emitter, parentId: undefined, depth: 0, limits });
          }, execSignal);
        } finally {
          if (ledgerActive) sessionLedger.endRun();
        }
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
          result.stderr,
          result.raised,
          result.pendingTasks,
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
