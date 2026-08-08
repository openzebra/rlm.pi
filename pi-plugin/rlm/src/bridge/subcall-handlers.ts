/**
 * The single implementation of the sub-LLM handler set (llm_query, llm_query_batched,
 * rlm_query, rlm_query_batched).
 *
 * Resolves AGENTS.md DRY #1–#5, which previously lived twice: once in `createLlmBridge` /
 * `createRlmHandlers` for the headless engine, once in `NativeBridgeState` for the repl()
 * tool. The two callers only ever differed in how they answer one question — "which emitter,
 * limits and parent node does THIS interrupt belong to?" — so that is the only thing they
 * still supply, as `resolve`. The engine binds one Invocation for a whole run; the repl()
 * tool swaps one per turn and routes `spawn()`ed work to its session registry.
 *
 * Concurrency: every leaf completion passes through `gates.leaf`, every child engine through
 * `gates.rlm.at(depth)`, so a sandbox that puts 25 batches on the wire at once is still
 * bounded session-wide. See util/concurrency.ts for why the rlm gate is per-depth.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { displayModelRef, modelRef, resolveModelId } from "../config/settings.ts";
import { type ChatMsg, modelComplete } from "./model.ts";
import { previewText } from "../text/preview.ts";
import { checkResourceLimits } from "../core/resource-limits.ts";
import { filterContextByPaths } from "../context/library-context.ts";
import type { RlmInput, RlmResult, Sampling } from "../core/types.ts";
import type { SubcallGates } from "../util/concurrency.ts";
import type { SubcallOpts, SubLlmHandlers } from "../sandbox/sandbox.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { errorMessage, formatError, isErrorText } from "../util/errors.ts";

/**
 * The slice of LimitGuard these handlers need. Narrow on purpose: the headless bridge is
 * constructed from a `remainingBudget()` callback rather than owning a guard, and both
 * shapes satisfy this.
 */
export interface InvocationLimits {
  remainingBudgetUsd(): number | undefined;
  remainingTimeoutMs(): number | undefined;
  addUsage(usage: Usage): void;
  addRaw(costUsd: number, inputTokens: number, outputTokens: number): void;
}

/**
 * Adapt a "how much is left?" callback to InvocationLimits.
 *
 * The headless engine owns the real LimitGuard and folds usage in through `onUsage` /
 * `onChildUsage`, so the accounting methods here are deliberately inert.
 */
export function limitsFromRemaining(
  remaining?: () => { readonly budgetUsd?: number; readonly timeoutMs?: number },
): InvocationLimits {
  return {
    remainingBudgetUsd: () => remaining?.().budgetUsd,
    remainingTimeoutMs: () => remaining?.().timeoutMs,
    addUsage: () => {},
    addRaw: () => {},
  };
}

/**
 * Where one interrupt's reporting and accounting go.
 *
 * Captured at interrupt entry and threaded down, never re-read: once handlers can outlive
 * their exec, re-reading mutable tool state after an await would attribute a sub-call to
 * whichever turn happens to be current when it resumes.
 */
export interface Invocation {
  readonly emitter: RlmEmitter;
  readonly parentId: string | undefined;
  readonly depth: number;
  readonly limits: InvocationLimits;
}

/**
 * The config slice these handlers read. Structurally satisfied by `RlmConfig`, and re-read on
 * every call so `/rlm-config` changes take effect without rebuilding the sandbox.
 */
export interface SubcallConfig {
  readonly maxPromptChars: number;
  readonly maxDepth: number;
  readonly subSampling?: Sampling;
  readonly subSystemPrompt?: string;
}

export interface SubcallHandlerDeps {
  /**
   * Pick the Invocation for this interrupt. `null` ⇒ the bridge is not wired yet.
   *
   * `depth` is the depth the sandbox reported. The headless engine trusts it (its handlers
   * serve one sandbox per depth); the repl() tool overrides it with its own turn depth.
   */
  readonly resolve: (opts: SubcallOpts, depth: number) => Invocation | null;
  /** Session-wide admission control. Required — a per-caller default would silently unbound it. */
  readonly gates: SubcallGates;
  readonly registry: ModelRegistry;
  readonly getWorkerModel: () => Model<Api>;
  /** Live accessor — `/rlm-config` replaces the config object, so never capture the value. */
  readonly getConfig: () => SubcallConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: Usage, role: "sub") => void;

  // ── recursion (omit all three to get llm-only handlers) ──
  /**
   * Spawns a child RLM for rlm_query.
   *
   * Receives the parent's Invocation so the child can report on the same emitter its
   * parent subcall node lives on — a child of detached work must not emit to a turn
   * emitter that will be shut down before it finishes, and keeping parent and child on
   * one emitter is what lets the session registry drain the subtree intact.
   */
  readonly runChild?: (input: RlmInput, inv: Invocation) => Promise<RlmResult>;
  /**
   * The parent's live context, read at spawn time and never captured: a library loaded on turn 3
   * must reach a child spawned on turn 4. `undefined`/`null` ⇒ no inheritance, and the child falls
   * back to prompt-as-context.
   *
   * This is the ONLY inheritance seam. Adding a second construction path for a child's world
   * would re-open issue #4 on whichever path forgets to grow.
   */
  readonly getChildContext?: () => unknown;
  readonly getModel?: () => Model<Api>;
  /**
   * What rlm_query degrades to at the depth cap. A child RLM there would just be an LM, so
   * both callers hand in their own one-shot path rather than re-deriving one here.
   */
  readonly degrade?: (prompt: string, model: string | null, depth: number) => Promise<string>;
  /** Called with a child run's totals so a caller-side guard can debit them too. */
  readonly onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
  /** Wraps detached work so a session registry can count what is still in flight. */
  readonly trackDetached?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** DRY #4 — the batch failure summary, previously written out in both copies. */
export function summarizeBatch(out: readonly string[]): { readonly failed: number; readonly error?: string } {
  let failed = 0;
  for (const item of out) if (isErrorText(item)) failed += 1;
  if (failed === 0) return { failed: 0 };
  const error = failed === out.length
    ? `all ${out.length} sub-calls failed — reduce batch size or try llm_query individually`
    : `${failed}/${out.length} sub-calls failed`;
  return { failed, error };
}

export type SubcallHandlers = Pick<
  SubLlmHandlers,
  "llmQuery" | "llmQueryBatched" | "rlmQuery" | "rlmQueryBatched"
>;

const UNWIRED = formatError("RLM bridge not wired for this invocation");

function emptyResult(answer: string): RlmResult {
  return { answer, iterations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

/** What a child RLM will see, plus any `paths=` prefix that selected nothing. */
interface ChildContext {
  readonly context: unknown;
  readonly unmatched: readonly string[];
}

const NO_UNMATCHED: readonly string[] = Object.freeze([]);

export function createSubcallHandlers(deps: SubcallHandlerDeps): SubcallHandlers {
  /** DRY #3 — the one display-model resolution. */
  const displayModel = (model: string | null): string =>
    displayModelRef(deps.registry, model, deps.getWorkerModel());

  /** Detached work is counted by the session registry; attached work runs as-is. */
  const detachable = <T>(opts: SubcallOpts, run: () => Promise<T>): Promise<T> =>
    opts.detached && deps.trackDetached !== undefined ? deps.trackDetached(run) : run();

  /** One leaf completion. Reports cost/tokens via `track`; never throws. */
  async function complete1(
    inv: Invocation,
    prompt: string,
    model: string | null,
    track: (usage: Usage) => void,
  ): Promise<string> {
    const config = deps.getConfig();
    const limitError = checkResourceLimits({
      budgetUsd: inv.limits.remainingBudgetUsd(),
      timeoutMs: inv.limits.remainingTimeoutMs(),
    });
    if (limitError !== undefined) return limitError;
    if (prompt.length > config.maxPromptChars) {
      return formatError(
        `sub-LLM prompt exceeded the size limit (${prompt.length.toLocaleString()} chars > ` +
        `${config.maxPromptChars.toLocaleString()}). Shorten or chunk the prompt before calling llm_query.`,
      );
    }
    const resolved = model ? resolveModelId(deps.registry, model) : undefined;
    if (model && !resolved) return formatError(`unknown model override '${model}'`);
    try {
      const messages: ChatMsg[] = [{ role: "user", content: prompt }];
      const res = await deps.gates.leaf.run(() => modelComplete(messages, {
        model: resolved ?? deps.getWorkerModel(),
        registry: deps.registry,
        system: config.subSystemPrompt,
        maxTokens: config.subSampling?.maxTokens,
        temperature: config.subSampling?.temperature,
        reasoning: config.subSampling?.reasoning,
        signal: deps.signal,
      }));
      inv.limits.addUsage(res.usage);
      deps.onUsage?.(res.usage, "sub");
      track(res.usage);
      return res.text;
    } catch (err) {
      const msg = errorMessage(err);
      const hint = /credit|402|payment|quota|rate.limit/i.test(msg)
        ? " — try smaller batches or individual llm_query calls"
        : "";
      return formatError(`${msg}${hint}`);
    }
  }

  /**
   * DRY #5 — the create → execute → update emit pattern for leaf sub-calls, in one place.
   * rlm_query does NOT use this: its node is created inside `childRun`, and a wrapper here
   * would double-report it.
   */
  async function emitting<T>(
    opts: SubcallOpts,
    depth: number,
    init: { kind: "llm" | "batch"; label: string; model: string | null; args: string },
    run: (inv: Invocation, track: (usage: Usage) => void) => Promise<T>,
    summarize: (out: T) => {
      readonly preview: string;
      readonly error?: string;
      readonly failed?: number;
      readonly total?: number;
    },
    unwired: () => T,
  ): Promise<T> {
    const inv = deps.resolve(opts, depth);
    if (inv === null) return unwired();
    const id = inv.emitter.emitSubcallCreated({
      kind: init.kind, parentId: inv.parentId, label: init.label,
      model: displayModel(init.model), args: init.args, depth: inv.depth,
    });
    let costUsd = 0;
    let tokens = 0;
    const track = (usage: Usage): void => { costUsd += usage.cost.total; tokens += usage.totalTokens; };
    const out = await detachable(opts, () => run(inv, track));
    const summary = summarize(out);
    inv.emitter.emitSubcallUpdated({
      id,
      status: summary.error !== undefined ? "error" : "done",
      costUsd, tokens,
      resultPreview: summary.preview,
      detail: summary.error,
      failedCount: summary.failed,
      totalCount: summary.total,
    });
    return out;
  }

  /**
   * Resolve the child's world: the parent's live context, optionally narrowed by path prefixes.
   *
   * Falls back to prompt-as-context when nothing is wired, and to the FULL context when `paths`
   * matched nothing — a silently blind child is exactly the bug this fixes, so a bad prefix
   * degrades loudly (see the note childRun folds into rootPrompt) rather than quietly.
   */
  function childContextFor(prompt: string, paths: readonly string[] | undefined): ChildContext {
    const inherited = deps.getChildContext?.();
    if (inherited === undefined || inherited === null) {
      return Object.freeze({ context: prompt, unmatched: NO_UNMATCHED });
    }
    if (paths === undefined || paths.length === 0) {
      return Object.freeze({ context: inherited, unmatched: NO_UNMATCHED });
    }
    const filtered = filterContextByPaths(inherited, paths);
    return Object.freeze({
      context: filtered.files.length > 0 ? filtered.files : inherited,
      unmatched: filtered.unmatched,
    });
  }

  /**
   * One child RLM run: depth cap → resource guard → spawn engine → debit parent.
   * Emits its own subcall node, so callers must not wrap it in another.
   */
  async function childRun(
    inv: Invocation,
    prompt: string,
    model: string | null,
    paths: readonly string[] | undefined,
  ): Promise<RlmResult> {
    const childDepth = inv.depth + 1;
    const run = deps.runChild;
    const maxDepth = deps.getConfig().maxDepth;

    // At the cap a child RLM would just be an LM — short-circuit to the caller's one-shot path.
    if (run === undefined || childDepth >= maxDepth) {
      const degrade = deps.degrade;
      const answer = degrade !== undefined
        ? await degrade(prompt, model, inv.depth)
        : await complete1(inv, prompt, model, () => {});
      return emptyResult(answer);
    }

    const remBudget = inv.limits.remainingBudgetUsd();
    const remTimeout = inv.limits.remainingTimeoutMs();
    const limitError = checkResourceLimits({ budgetUsd: remBudget, timeoutMs: remTimeout });
    if (limitError) return emptyResult(limitError);

    const rootModel = deps.getModel?.();
    const resolvedOverride = model ? resolveModelId(deps.registry, model) : undefined;
    const modelLabel = model
      ? (modelRef(resolvedOverride) ?? `unknown/${model}`)
      : (rootModel === undefined ? undefined : (modelRef(rootModel) ?? rootModel.id));
    const subId = inv.emitter.emitSubcallCreated({
      kind: "rlm", parentId: inv.parentId, label: "rlm_query",
      model: modelLabel, detail: prompt.slice(0, 60), depth: childDepth,
    });
    // The child's context is the parent's world, not the prompt text. The prompt becomes the
    // child's rootPrompt, exactly as a depth-0 run takes the user's question.
    const child = childContextFor(prompt, paths);
    const rootPrompt = child.unmatched.length === 0
      ? prompt
      : `${prompt}\n\n[rlm] paths=${child.unmatched.join(", ")} matched no files; you received the full context.`;
    try {
      const res = await deps.gates.rlm.at(childDepth).run(() => run({
        rootPrompt,
        context: child.context,
        depth: childDepth,
        parentNodeId: subId,
        modelOverride: model ?? undefined,
        remainingBudgetUsd: remBudget,
        remainingTimeoutMs: remTimeout,
      }, inv));
      inv.limits.addRaw(res.costUsd, res.inputTokens, res.outputTokens);
      deps.onChildUsage?.(res.costUsd, res.inputTokens, res.outputTokens);
      // The child emits live usage deltas on the shared emitter, so no aggregate cost here
      // — adding it would double-count against SubcallStore's running totals.
      inv.emitter.emitSubcallUpdated({ id: subId, status: "done", resultPreview: res.answer.slice(0, 200) });
      return res;
    } catch (err) {
      const msg = errorMessage(err);
      inv.emitter.emitSubcallUpdated({ id: subId, status: "error", detail: msg });
      return emptyResult(formatError(`child RLM failed - ${msg}`));
    }
  }

  return {
    llmQuery: (prompt, model, depth, opts) => emitting(
      opts, depth,
      { kind: "llm", label: "llm_query", model, args: `prompt: ${previewText(prompt)}` },
      (inv, track) => complete1(inv, prompt, model, track),
      (out) => ({ preview: previewText(out), error: isErrorText(out) ? out : undefined }),
      () => UNWIRED,
    ),

    llmQueryBatched: (prompts, model, depth, opts) => emitting(
      opts, depth,
      { kind: "batch", label: `llm_query ×${prompts.length}`, model, args: `prompt: ${previewText(prompts[0] ?? "")}` },
      // NO outer gate. `complete1` already takes the single `leaf` slot each prompt needs;
      // an outer `gates.leaf.map` here deadlocked every batch of >= limit prompts.
      (inv, track) => Promise.all(prompts.map((p) => complete1(inv, p, model, track))),
      (out) => {
        const { failed, error } = summarizeBatch(out);
        const first = previewText(out[0] ?? "");
        return {
          preview: out.length > 1 ? `${first}  (+${out.length - 1} more)` : first,
          error, failed, total: out.length,
        };
      },
      () => prompts.map(() => UNWIRED),
    ),

    async rlmQuery(prompt, model, depth, opts) {
      const inv = deps.resolve(opts, depth);
      if (inv === null) return UNWIRED;
      return detachable(opts, async () => (await childRun(inv, prompt, model, opts.paths)).answer);
    },

    async rlmQueryBatched(prompts, model, depth, opts) {
      const inv = deps.resolve(opts, depth);
      if (inv === null) return prompts.map(() => UNWIRED);
      // Bounded by the per-depth rlm gate inside childRun, not by an outer pool.
      return detachable(opts, async () => {
        const results = await Promise.all(prompts.map((p) => childRun(inv, p, model, opts.paths)));
        return results.map((r) => r.answer);
      });
    },
  };
}
