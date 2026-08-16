/**
 * TaskLedger — the session blackboard (port of rlm_test v5 `ledger.py`).
 *
 * One instance per root run (engine) or per session (native repl tool), threaded down to every
 * child through `SubcallHandlerDeps.ledger` / `RlmInput.ledger` — the same seam as
 * getChildContext. It gives every agent global state visibility (the `[ledger]` block) and
 * stops duplicate work three ways:
 *   - exact-hash coalesce: identical task → one runner, many waiters
 *   - ancestor-echo reject: a child restating an ancestor task gets a stub
 *   - near-dup coalesce: Jaccard ≥ 0.8, or ≥ 0.7 with the same path set
 * plus the `rlmBudget` demotion counter (extra rlm_query → llm_query).
 */

import { createHash } from "node:crypto";

const NOISE = /\b(no edits?|do not edit|analysis[- ]only|do not change)\.?/gi;
const TOK = /[a-z0-9_]{2,}/g;
const NEAR_JACCARD = 0.8;
const NEAR_JACCARD_SAME_PATHS = 0.7;
const ECHO_JACCARD = 0.8;
const INFLIGHT_LINES = 8;
const DONE_LINES = 6;
const PROMPT_PREVIEW = 80;
/** v5 wait() parity (audit H1): a coalescing twin never parks forever. Generous default —
 *  a twin can legitimately wait out a full child engine run. */
export const WAIT_TIMEOUT_MS = 600_000;

export type ClaimKind = "llm" | "rlm";
export type ClaimStatus = "pending" | "running" | "done" | "error";

/** All-readonly (project rule): transitions replace the map entry with a new frozen Claim. */
export interface Claim {
  readonly key: string;
  readonly kind: ClaimKind;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly depth: number;
  readonly status: ClaimStatus;
  readonly result: string | null;
}

export interface ClaimRequest {
  readonly kind: ClaimKind;
  readonly prompt: string;
  readonly paths: readonly string[];
  readonly depth: number;
}

/** Result of `tryClaim` — a discriminated union, never an exception. */
export type ClaimDecision =
  | { readonly type: "run"; readonly key: string }
  | { readonly type: "coalesce"; readonly key: string; readonly done: boolean }
  | { readonly type: "echo" };

export interface LedgerHits {
  readonly exact: number;
  readonly echo: number;
  readonly near: number;
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

/** Type guard (project rule: no `as` narrowing) — used by contextSig over unknown payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  return sha256Hex(String(context)).slice(0, 16);
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
  "[ledger echo] this task restates an ancestor goal — the parent run already covers it. " +
    "Do not spawn a duplicate; answer from what you already know or await the existing task.",
);

const RLM_CALL_OPEN = /\brlm_(?:query|batch)\s*\(/g;

/**
 * Native `repl()` cells are Python, not a task (audit R1). Pull quoted
 * `rlm_query` / `rlm_batch` arguments so `beginRun` has a task-shaped ancestor
 * instead of `print` / `await_task` tokens. Falls back to the raw cell when no
 * such call is present. `paths=` keyword args are not tasks.
 */
export function nativeRunAncestors(code: string): readonly string[] {
  const found = extractRlmTaskPrompts(code);
  return Object.freeze(found.length > 0 ? found : [code]);
}

function extractRlmTaskPrompts(code: string): readonly string[] {
  const out: string[] = [];
  RLM_CALL_OPEN.lastIndex = 0;
  for (const m of code.matchAll(RLM_CALL_OPEN)) {
    const start = (m.index ?? 0) + m[0].length;
    const body = sliceCallBody(code, start);
    const pathSplit = body.split(/\bpaths\s*=/);
    const taskPart = pathSplit[0] ?? body;
    const strings = quotedStrings(taskPart);
    for (let i = 0; i < strings.length; i++) {
      const s = strings[i];
      if (s !== undefined && s.trim() !== "") out.push(s);
    }
  }
  return out;
}

function sliceCallBody(src: string, start: number): string {
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipPyString(src, i);
      continue;
    }
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  return src.slice(start, depth === 0 ? i - 1 : i);
}

function quotedStrings(src: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const parsed = readPyString(src, i);
      if (parsed.keep) out.push(parsed.value);
      i = parsed.end;
      continue;
    }
    i++;
  }
  return out;
}

function skipPyString(src: string, quoteAt: number): number {
  return readPyString(src, quoteAt).end;
}

function readPyString(
  src: string,
  quoteAt: number,
): { readonly value: string; readonly end: number; readonly keep: boolean } {
  const quote = src[quoteAt] ?? '"';
  const prefix = quoteAt > 0 ? src[quoteAt - 1] : "";
  const keep = prefix !== "f" && prefix !== "F";
  const triple = src.startsWith(quote + quote + quote, quoteAt);
  const delimLen = triple ? 3 : 1;
  const from = quoteAt + delimLen;
  if (triple) {
    const close = src.indexOf(quote + quote + quote, from);
    if (close === -1) return { value: src.slice(from), end: src.length, keep };
    return { value: src.slice(from, close), end: close + 3, keep };
  }
  const parts: string[] = [];
  let j = from;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      parts.push(src[j + 1] ?? "");
      j += 2;
      continue;
    }
    if (ch === quote) return { value: parts.join(""), end: j + 1, keep };
    parts.push(ch ?? "");
    j++;
  }
  return { value: parts.join(""), end: src.length, keep };
}

export class TaskLedger {
  private readonly claims = new Map<string, Claim>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly stack: string[] = [];
  private readonly hitCounts = { exact: 0, echo: 0, near: 0 };
  private rlmRuns = 0;

  /** Engine marks the active run's root prompt — the ancestor chain for echo detection. */
  beginRun(rootPrompt: string): void {
    this.stack.push(normalizePrompt(rootPrompt));
  }

  endRun(): void {
    this.stack.pop();
  }

  /** Native `repl()` path (audit R1): push task-shaped ancestors extracted from the cell. */
  beginNativeCell(code: string): number {
    const ancestors = nativeRunAncestors(code);
    for (let i = 0; i < ancestors.length; i++) {
      const a = ancestors[i];
      if (a !== undefined) this.beginRun(a);
    }
    return ancestors.length;
  }

  endNativeCell(n: number): void {
    for (let i = 0; i < n; i++) this.endRun();
  }

  /** A child prompt echoing any ancestor (exact or ≥ 0.8 Jaccard) is rejected as a stub. */
  detectEcho(prompt: string): boolean {
    const np = normalizePrompt(prompt);
    if (np === "") return false;
    const toks = tokenSet(np);
    for (const anc of this.stack) {
      if (anc === np) return true;
      if (anc !== "" && jaccard(toks, tokenSet(anc)) >= ECHO_JACCARD) return true;
    }
    return false;
  }

  /** Near-duplicate over inflight + done claims (Jaccard, or lower bar with identical paths). */
  findNear(prompt: string, paths: readonly string[]): Claim | undefined {
    const toks = tokenSet(normalizePrompt(prompt));
    const ps = pathSig(paths);
    for (const c of this.claims.values()) {
      if (c.status === "error") continue;
      const score = jaccard(toks, tokenSet(normalizePrompt(c.prompt)));
      if (score >= NEAR_JACCARD) return c;
      if (score >= NEAR_JACCARD_SAME_PATHS && pathSig(c.paths) === ps) return c;
    }
    return undefined;
  }

  /** Exact-key lookup among live (non-error) claims. */
  lookup(key: string): Claim | undefined {
    const c = this.claims.get(key);
    return c !== undefined && c.status !== "error" ? c : undefined;
  }

  /** Atomically decide: run it, coalesce onto an existing runner, or reject as echo. */
  tryClaim(req: ClaimRequest, key: string): ClaimDecision {
    if (this.detectEcho(req.prompt)) {
      this.hitCounts.echo++;
      return { type: "echo" };
    }
    const exact = this.lookup(key);
    if (exact !== undefined) {
      this.hitCounts.exact++;
      return { type: "coalesce", key, done: exact.status === "done" };
    }
    const near = this.findNear(req.prompt, req.paths);
    if (near !== undefined) {
      this.hitCounts.near++;
      return { type: "coalesce", key: near.key, done: near.status === "done" };
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

  /** Compact table for the sandbox's `list_claims()` REPL call. */
  listClaims(): string {
    if (this.claims.size === 0) return "ledger: no claims";
    const lines: string[] = new Array<string>(this.claims.size + 1);
    lines[0] = "ledger claims:";
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
      `  depth_stack=${stackN} inflight=${inflight.length} done=${done.length}`,
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
