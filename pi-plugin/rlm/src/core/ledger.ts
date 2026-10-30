/**
 * TaskLedger — the session blackboard (port of the v5 `ledger.py` engine).
 *
 * One instance per root run (engine) or per session (native repl tool), threaded down to every
 * child through `SubcallHandlerDeps.ledger` / `RlmInput.ledger` — the same seam as
 * getChildContext. It gives every agent global state visibility (the `[ledger]` block) and
 * stops duplicate work two ways:
 *   - exact-hash coalesce: identical task → one runner, many waiters
 *   - ancestor-echo reject: a child restating an ancestor task gets a stub
 * plus the `rlmBudget` demotion counter (extra rlm_query → llm_query). Similar-but-different
 * prompts are never coalesced: a shared frame with a different question is a different task,
 * and handing it another task's result is a silent wrong answer.
 */

import { createHash } from "node:crypto";
import { isRecord } from "../util/type-guards.ts";

const NOISE = /\b(no edits?|do not edit|analysis[- ]only|do not change)\.?/gi;
const TOK = /[a-z0-9_]{2,}/g;
const ECHO_JACCARD = 0.8;
const INFLIGHT_LINES = 8;
const DONE_LINES = 6;
const PROMPT_PREVIEW = 80;
/** v5 wait() parity (audit H1): a coalescing twin never parks forever. Generous default —
 *  a twin can legitimately wait out a full child engine run. */
const WAIT_TIMEOUT_MS = 600_000;

type ClaimKind = "llm" | "rlm";
type ClaimStatus = "pending" | "running" | "done" | "error";

/** All-readonly (project rule): transitions replace the map entry with a new frozen Claim. */
interface Claim {
  readonly key: string;
  readonly kind: ClaimKind;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly depth: number;
  readonly status: ClaimStatus;
  readonly result: string | null;
}

interface ClaimRequest {
  readonly kind: ClaimKind;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly depth: number;
}

/** Result of `tryClaim` — a discriminated union, never an exception. */
type ClaimDecision =
  | { readonly type: "run"; readonly key: string }
  | { readonly type: "coalesce"; readonly key: string; readonly done: boolean }
  | { readonly type: "echo" };

interface LedgerHits {
  readonly exact: number;
  readonly echo: number;
}

interface Waiter {
  readonly resolve: (result: string) => void;
  readonly reject: (err: Error) => void;
}

/** v5 `normalize_prompt`: lowercase, strip standing instructions noise, fold whitespace.
 *  v5 strips trailing periods too (`.strip(" .\t")`) — `trimEnd(" .")` mirrors that. */
export function normalizePrompt(prompt: string): string {
  NOISE.lastIndex = 0;
  return prompt
    .toLowerCase()
    .replace(NOISE, " ")
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .\t]+|[ .\t]+$/g, "");
}

export function tokenSet(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(TOK) ?? []);
}

/**
 * Target-specific identifiers in a prompt (paths with `/`, filenames with extensions,
 * snake_case symbols, or numeric/ordinal module indices). Two templated prompts that
 * differ in their target identifiers (e.g. `crates/hf_app` vs `crates/hf_body`) are
 * distinct tasks, never ancestor echoes.
 */
const TARGET_TOK =
  /(?:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+|\b[a-z0-9_-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml|sh|sql|css|html|c|cc|cpp|h|hpp|java|kt|swift|rb)\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|alpha|beta|gamma|delta)\b)/gi;

export function targetTokenSet(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(TARGET_TOK) ?? []);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function pathSig(paths: readonly string[]): string {
  const cleaned = new Set<string>();
  for (const p of paths) {
    if (p) cleaned.add(p.replace(/\\/g, "/").replace(/\/+$/, ""));
  }
  return [...cleaned].sort().join(",");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** v5 `context_sig`: fingerprint a packed context so same-question/different-haystack never collide. */
export function contextSig(context: unknown): string {
  if (context === undefined || context === null) return "";
  if (typeof context === "string") return context === "" ? "" : sha256Hex(context).slice(0, 16);
  if (Array.isArray(context)) {
    const h = createHash("sha256");
    for (const item of context) {
      if (isRecord(item)) {
        const path = typeof item.path === "string" ? item.path : "";
        const body = typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : "";
        h.update(path);
        h.update("\0");
        h.update(body);
        h.update("\n");
      } else {
        h.update(String(item));
        h.update("\n");
      }
    }
    return h.digest("hex").slice(0, 16);
  }
  // JSON (not String()): String(obj) collapsed EVERY object context to "[object Object]".
  return sha256Hex(JSON.stringify(context)).slice(0, 16);
}

export function taskKey(
  kind: string,
  prompt: string,
  paths: readonly string[],
  model: string,
  ctx: string,
): string {
  const raw = `${kind}|${model}|${pathSig(paths)}|${normalizePrompt(prompt)}|${ctx}`;
  return sha256Hex(raw).slice(0, 24);
}

export const ECHO_STUB: string = Object.freeze(
  "[ledger: ancestor echo rejected. You are already doing this task. " +
    "Use context / answers / the files already in scope. Do not rlm_query the parent task.]",
);

interface AncestorEntry {
  readonly id: number;
  readonly depth: number;
  readonly prompt: string;
  readonly tokens: ReadonlySet<string>;
  readonly targets: ReadonlySet<string>;
}

export class TaskLedger {
  private readonly claims = new Map<string, Claim>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly stack: AncestorEntry[] = [];
  private readonly hitCounts = { exact: 0, echo: 0 };
  private rlmRuns = 0;
  private nextRunId = 0;

  /** Engine marks the active run's root prompt and depth — the ancestor chain for echo detection.
   *  v5 `begin_run` parity: the ONLY producer. `endRun` removes by run token (or pops LIFO when
   *  called with no arg), so concurrent async children at `depth = 1` never corrupt each other's
   *  stack slots or mistake siblings (`anc.depth === req.depth`) for ancestors (`anc.depth < req.depth`). */
  beginRun(rootPrompt: string, depth = 0): number {
    const np = normalizePrompt(rootPrompt);
    const id = ++this.nextRunId;
    this.stack.push(Object.freeze({
      id,
      depth,
      prompt: np,
      tokens: tokenSet(np),
      targets: targetTokenSet(np),
    }));
    return id;
  }

  endRun(id?: number): void {
    if (id === undefined) {
      this.stack.pop();
      return;
    }
    const idx = this.stack.findIndex((entry) => entry.id === id);
    if (idx >= 0) this.stack.splice(idx, 1);
  }

  /** Reset the per-turn `rlmBudget` counter while preserving completed claims for reuse. */
  resetTurnBudget(): void {
    this.rlmRuns = 0;
  }

  /** A child prompt echoing any strictly shallower ancestor (`anc.depth < reqDepth`) is rejected as a stub. */
  detectEcho(prompt: string, reqDepth?: number): boolean {
    const np = normalizePrompt(prompt);
    if (np === "") return false;
    const toks = tokenSet(np);
    const targets = targetTokenSet(np);
    for (const anc of this.stack) {
      if (reqDepth !== undefined && anc.depth >= reqDepth) continue;
      if (anc.prompt === np) return true;
      if (anc.prompt === "") continue;
      if ((targets.size > 0 || anc.targets.size > 0) && !sameSet(targets, anc.targets)) continue;
      if (jaccard(toks, anc.tokens) >= ECHO_JACCARD) return true;
    }
    return false;
  }

  /** Exact-key lookup among live (non-error) claims. */
  lookup(key: string): Claim | undefined {
    const c = this.claims.get(key);
    return c !== undefined && c.status !== "error" ? c : undefined;
  }

  /** Atomically decide: run it, coalesce onto an existing runner, or reject as echo. */
  tryClaim(req: ClaimRequest, key: string): ClaimDecision {
    if (this.detectEcho(req.prompt, req.depth)) {
      this.hitCounts.echo++;
      return { type: "echo" };
    }
    const exact = this.lookup(key);
    if (exact !== undefined) {
      this.hitCounts.exact++;
      return { type: "coalesce", key, done: exact.status === "done" };
    }
    this.claims.set(key, Object.freeze({
      key,
      kind: req.kind,
      prompt: req.prompt,
      paths: Object.freeze([...req.paths]),
      depth: req.depth,
      status: "pending",
      result: null,
    }));
    if (req.kind === "rlm") this.rlmRuns++;
    return { type: "run", key };
  }

  /** v5 `begin_run` parity: the runner actually started — inflight lines say "running". */
  markRunning(key: string): void {
    const claim = this.claims.get(key);
    if (claim === undefined || claim.status !== "pending") return;
    this.claims.set(key, Object.freeze({ ...claim, status: "running" }));
  }

  /** Park a waiter on a claim (coalescing twin). Bounded by `timeoutMs` (audit H1): a dead
   *  runner must park nobody forever. Rejects immediately on an errored claim. */
  waitFor(key: string, timeoutMs: number = WAIT_TIMEOUT_MS): Promise<string> {
    const claim = this.claims.get(key);
    if (claim !== undefined && claim.status === "done" && claim.result !== null) {
      return Promise.resolve(claim.result);
    }
    if (claim !== undefined && claim.status === "error") {
      return Promise.reject(new Error(`ledger: claim ${key} failed while waiting`));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(key);
        if (waiters === undefined) return;
        this.waiters.set(key, waiters.filter((w) => w.resolve !== resolve && w.reject !== reject));
        reject(new Error(`[ledger: timeout waiting for ${key}]`));
      }, timeoutMs);
      const wrapped: Waiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const list = this.waiters.get(key) ?? [];
      list.push(wrapped);
      this.waiters.set(key, list);
    });
  }

  /** Runner finished — store the result and wake every coalescing waiter. */
  finish(key: string, result: string): void {
    const claim = this.claims.get(key);
    if (claim === undefined) return;
    this.claims.set(key, Object.freeze({ ...claim, status: "done", result }));
    this.wake(key, result, undefined);
  }

  /** Runner failed — waiters get the error; the key becomes claimable again. */
  fail(key: string, error: string): void {
    const claim = this.claims.get(key);
    if (claim === undefined) return;
    this.claims.set(key, Object.freeze({ ...claim, status: "error" }));
    this.wake(key, undefined, new Error(error));
  }

  private wake(key: string, result: string | undefined, err: Error | undefined): void {
    const list = this.waiters.get(key);
    if (list === undefined) return;
    this.waiters.delete(key);
    for (const w of list) {
      if (err !== undefined) w.reject(err);
      else if (result !== undefined) w.resolve(result);
    }
  }

  /** Real rlm runs started (claimed) — drives the `rlmBudget` demotion. */
  rlmCount(): number {
    return this.rlmRuns;
  }

  hits(): LedgerHits {
    return Object.freeze({ ...this.hitCounts });
  }

  /** Compact table for the sandbox's `list_claims()` REPL call. Echo hits are appended —
   *  a suppressed spawn must be visible from inside the session (audit BUG-1). */
  listClaims(): string {
    const echoNote = this.hitCounts.echo > 0 ? ` (echo_rejected=${this.hitCounts.echo})` : "";
    if (this.claims.size === 0) return `ledger: no claims${echoNote}`;
    const lines: string[] = new Array<string>(this.claims.size + 1);
    lines[0] = `ledger claims:${echoNote}`;
    let n = 1;
    for (const c of this.claims.values()) {
      lines[n++] = `  ${c.key.slice(0, 8)} ${c.kind} ${c.status} depth=${c.depth} paths=${pathSig(c.paths) || "-"} '${c.prompt.slice(0, PROMPT_PREVIEW)}'`;
    }
    return lines.slice(0, n).join("\n");
  }

  /** v5 verbatim `[ledger]` block — empty when nothing is claimed and the stack is shallow. */
  injectBlock(): string {
    const inflight: string[] = [];
    const done: string[] = [];
    for (const c of this.claims.values()) {
      const line = `  ${c.key.slice(0, 8)} ${c.kind} paths=${pathSig(c.paths) || "-"} '${c.prompt.slice(0, PROMPT_PREVIEW)}'`;
      if (c.status === "pending" || c.status === "running") inflight.push(line);
      else if (c.status === "done") done.push(line);
    }
    const stackN = this.stack.length;
    if (inflight.length === 0 && done.length === 0 && stackN <= 1) return "";
    const lines: string[] = [
      "[ledger]",
      `  depth_stack=${stackN} inflight=${inflight.length} done=${done.length}` +
        (this.hitCounts.echo > 0 ? ` echo_rejected=${this.hitCounts.echo}` : ""),
      "  rlm_query only for a disjoint goal. ancestor echo is rejected.",
    ];
    if (inflight.length > 0) {
      lines.push("  inflight:");
      lines.push(...inflight.slice(0, INFLIGHT_LINES));
    }
    if (done.length > 0) {
      lines.push("  done:");
      lines.push(...done.slice(0, DONE_LINES));
    }
    return lines.join("\n");
  }
}
