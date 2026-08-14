/**
 * PythonSandbox — owns one `python3 worker.py` subprocess and the JSONL stdio pump.
 *
 * The pump multiplexes two concerns on one pipe:
 *   1. request/response (exec, load_context, shutdown), keyed by `id`;
 *   2. mid-exec sub-LLM interrupts (llm_query/rlm_query), serviced in-process by handlers
 *      the engine/bridge installs — the worker never sees API keys.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInterrupt,
  isWorkerMessage,
  parsePendingTasks,
  type ParentMessage,
  type ReplResult,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import { pinContext, type PinnedContext } from "./context-file.ts";
import { REJECT, serviceInterrupt, type ReplyBody, type SubLlmHandlers } from "./interrupts.ts";
import { trace, traceEnabled } from "../util/trace.ts";

export type { AddContextResult, SubcallOpts, SubLlmHandlers } from "./interrupts.ts";

export interface SandboxOptions {
  /** Sandbox recursion depth label (passed to the worker, used in interrupt routing). */
  readonly depth?: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  readonly execTimeoutS?: number;
  /** Parent-side watchdog per request (ms); on breach the worker is SIGKILLed. */
  readonly requestTimeoutMs?: number;
  /** Python executable. */
  readonly python?: string;
  /** Handlers for sub-LLM interrupts. Defaults reject (Phase 1 has no bridge yet). */
  readonly handlers?: Partial<SubLlmHandlers>;
  /** AbortSignal — immediate SIGKILL on abort, bypassing the shutdown handshake. */
  readonly signal?: AbortSignal;
  /** Worker startup wait before init failure (ms). */
  readonly initTimeoutMs?: number;
  /** Sub-LLM prompt cap (chars) — sizes llm_query_chunked chunks inside the worker. */
  readonly maxPromptChars?: number;
  /**
   * Max seconds the worker will wait for a host reply while parked in `_drain_until`
   * (await_task / sync sub-call). Defaults to the worker's own RLM_AWAIT_TIMEOUT_S (600).
   */
  readonly awaitTimeoutS?: number;
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "py", "worker.py");
const STDERR_TAIL_CHARS = 8_192;
/** How long dispose() waits for a clean worker exit before escalating to SIGKILL. */
const SHUTDOWN_GRACE_MS = 50;

// The sandbox runs untrusted model-authored code; it must never inherit provider secrets.
const SENSITIVE_ENV = /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|_KEY$/i;

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SENSITIVE_ENV.test(k)) env[k] = v;
  }
  return env;
}

/** Distributive omit so each union member keeps its own fields (plain Omit collapses to shared keys). */
type RequestBody = WorkerRequest extends infer T ? (T extends { id: string } ? Omit<T, "id"> : never) : never;

type Pending = {
  readonly resolve: (res: WorkerResponse) => void;
  readonly reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  readonly requestType: string;
};

export class PythonSandbox {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private scanOffset = 0;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers: SubLlmHandlers;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;
  /** Bounded stderr tail (chunks, newest last) — avoids rebuilding the buffer per chunk. */
  private readonly stderrTail: string[] = [];
  private stderrLen = 0;

  /** Bounded tail of everything written to stderr, oldest chunks already dropped. */
  private get stderr(): string {
    return this.stderrTail.join("");
  }

  /** Record a diagnostic on the same bounded tail as real worker stderr. */
  private appendStderr(text: string): void {
    this.stderrTail.push(text);
    this.stderrLen += text.length;
    while (this.stderrLen > STDERR_TAIL_CHARS && this.stderrTail.length > 1) {
      this.stderrLen -= (this.stderrTail.shift() ?? "").length;
    }
  }
  private disposed = false;
  private ready: Promise<void>;

  private constructor(opts: SandboxOptions) {
    this.handlers = { ...REJECT, ...opts.handlers };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20 * 60_000;
    this.initTimeoutMs = opts.initTimeoutMs ?? 30_000;
    const python = opts.python ?? "python3";
    const workerArgs = [
      // -X utf8=1: the scaffold states its own encoding explicitly (py/hostio.py), but MODEL
      // code gets a real open() — guards.py exposes it deliberately — and on Windows that
      // would default to cp1252 (issue #7). UTF-8 mode covers the whole interpreter; the
      // scaffold's explicit encoding= still wins where PYTHONIOENCODING would override this.
      "-X", "utf8=1",
      "-u", WORKER_PATH,
      "--depth", String(opts.depth ?? 1),
      "--timeout", String(opts.execTimeoutS ?? 600),
    ];
    if (opts.maxPromptChars !== undefined) {
      workerArgs.push("--max-prompt-chars", String(opts.maxPromptChars));
    }
    if (opts.awaitTimeoutS !== undefined) {
      workerArgs.push("--await-timeout", String(opts.awaitTimeoutS));
    }
    this.proc = spawn(
      python,
      workerArgs,
      // windowsHide: without it each sandbox flashes a console window on Windows (pi sets
      // this on every spawn — bash.ts / shell.ts). Same Windows surface as issue #7.
      { stdio: ["pipe", "pipe", "pipe"], env: sanitizedEnv(), windowsHide: true },
    ) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => this.appendStderr(chunk));

    // A dead worker's pipe fails the write ASYNCHRONOUSLY: node emits 'error' on the stream, and
    // an EventEmitter 'error' with no listener is an uncaughtException — which no try/catch
    // around send() and no `await dispose().catch()` can intercept. Without these three
    // listeners a worker dying mid-exec took the entire pi process down with it (EPIPE from the
    // shutdown frame dispose() writes after the watchdog SIGKILLs).
    // Record and swallow: the real reason is already surfaced by failAll on 'exit'.
    const swallowPipeError = (stream: string) => (err: NodeJS.ErrnoException): void => {
      this.appendStderr(`[rlm] worker ${stream} ${err.code ?? "error"}: ${err.message}\n`);
    };
    this.proc.stdin.on("error", swallowPipeError("stdin"));
    this.proc.stdout.on("error", swallowPipeError("stdout"));
    this.proc.stderr.on("error", swallowPipeError("stderr"));

    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      const hint = err.code === "ENOENT" ? ` ('${python}' not found — is Python installed and on PATH?)` : "";
      this.failAll(new Error(`failed to start sandbox${hint}: ${err.message}`));
    });
    // Name the cause: a SIGKILL (watchdog, abort, OOM killer) reads very differently from a
    // Python-level crash, and this message is what reaches the user as `REPL error: …`.
    this.proc.on("exit", (code, signal) => this.failAll(new Error(
      `worker exited (${signal !== null ? `signal ${signal}` : `code ${code}`}); `
      + `stderr=${this.stderr.trim()}`,
    )));

    this.ready = this.waitForInit();

    // Immediate SIGKILL on abort — no shutdown handshake, no 50ms wait.
    if (opts.signal) {
      if (opts.signal.aborted) {
        this.disposed = true;
        this.proc.kill("SIGKILL");
        this.failAll(new Error("sandbox aborted"));
      } else {
        opts.signal.addEventListener("abort", () => {
          if (!this.disposed) {
            this.disposed = true;
            try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
            this.failAll(new Error("sandbox aborted"));
          }
        }, { once: true });
      }
    }
  }

  /** Spawn a sandbox and wait until the worker reports it is initialized. */
  static async spawn(opts: SandboxOptions = {}): Promise<PythonSandbox> {
    const sandbox = new PythonSandbox(opts);
    await sandbox.ready;
    return sandbox;
  }

  /**
   * Load a payload whose pin this sandbox does not own — it acquires and releases one itself.
   * Used by SandboxManager and tests; the engine owns its run's pin and calls the pinned form.
   */
  async loadContext(payload: unknown): Promise<number> {
    const pinned = await pinContext(payload);
    try {
      return await this.loadContextPinned(pinned);
    } finally {
      await pinned.release();
    }
  }

  /**
   * Load from a pin the CALLER owns and will release. Keeping ownership outside means a run and
   * every child that inherits its payload share one serialization and one file.
   */
  async loadContextPinned(pinned: PinnedContext): Promise<number> {
    const res = await this.request({ type: "load_context", path: pinned.path, json: pinned.json });
    if (!res.ok) throw new Error(res.error ?? "load_context failed");
    return res.index ?? 0;
  }

  async exec(code: string, signal?: AbortSignal): Promise<ReplResult> {
    const res = await this.request({ type: "exec", code }, signal);
    if (!res.ok) throw new Error(res.error ?? "exec failed");
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      finalAnswer: res.final_answer ?? null,
      answerContent: res.answer_content ?? "",
      raised: res.raised ?? false,
      executionTimeMs: Math.round((res.execution_time ?? 0) * 1000),
      varNames: res.var_names ?? [],
      pendingTasks: parsePendingTasks(res.pending_tasks),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Handshake only a live worker. The watchdog SIGKILLs before SandboxManager's catch calls
    // dispose(), and writing the shutdown frame to a process that is already dead is exactly
    // what produced the EPIPE that killed the host. Skipping it also drops a pointless 50ms
    // wait from every dead-worker teardown.
    if (this.workerAlive) {
      this.send({ id: "_shutdown", type: "shutdown" });
      // Wait for the worker to actually go rather than sleeping a fixed 50ms: this returns the
      // instant it exits (the common case) and still gives up promptly if it never will, in
      // which case the SIGKILL below finishes the job.
      await once(this.proc, "exit", { signal: AbortSignal.timeout(SHUTDOWN_GRACE_MS) })
        .catch(() => { /* did not exit in time — SIGKILL below */ });
    }
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    this.failAll(new Error("sandbox disposed"));
  }

  // ---- internals ------------------------------------------------------------------------

  private waitForInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not start in time")), this.initTimeoutMs);
      this.pending.set("_init", {
        resolve: (res) => {
          clearTimeout(timer);
          res.ok ? resolve() : reject(new Error(res.error ?? "worker init failed"));
        },
        reject,
        timer,
        requestType: "init",
      });
    });
  }

  private request(payload: RequestBody, signal?: AbortSignal): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new Error("sandbox disposed"));
    if (signal?.aborted) return Promise.reject(new Error("repl execution aborted"));
    // Reject before registering the pending entry: `send` no-ops for a dead worker, so a request
    // queued here would otherwise sit until the watchdog fired instead of failing now.
    if (!this.workerAlive) {
      return Promise.reject(new Error(
        `worker is not running (${this.exitDescription()}); request '${payload.type}' not sent`,
      ));
    }
    const id = `r${++this.seq}`;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = this.createWatchdog(id, payload.type, reject);
      // Cancel == kill. The worker may be parked inside `_drain_until` with no other way out;
      // `proc.on("exit") -> failAll` settles this request and SandboxManager's catch recreates
      // the sandbox. REPL variables are lost — the documented price of interrupting.
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        try { this.proc.kill("SIGKILL"); } catch { /* already dead */ }
        reject(new Error("repl execution aborted — REPL variables were reset"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const once = <T>(settle: (value: T) => void) => (value: T): void => {
        signal?.removeEventListener("abort", onAbort);
        settle(value);
      };
      this.pending.set(id, { resolve: once(resolve), reject: once(reject), timer, requestType: payload.type });
      this.send({ id, ...payload } as ParentMessage);
    });
  }

  private createWatchdog(id: string, requestType: string, reject: (err: Error) => void): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.pending.delete(id);
      this.proc.kill("SIGKILL");
      reject(new Error(`request '${requestType}' exceeded ${this.requestTimeoutMs}ms with no progress; worker killed`));
    }, this.requestTimeoutMs);
  }

  private touchPending(): void {
    for (const [id, p] of this.pending) {
      if (id === "_init") continue;
      clearTimeout(p.timer);
      p.timer = this.createWatchdog(id, p.requestType, p.reject);
    }
  }

  /**
   * Refresh the parent-side request watchdog for every pending request.
   * Used during long mid-exec work that does not
   * produce additional worker interrupts on this sandbox.
   */
  refreshWatchdog(): void {
    this.touchPending();
  }

  private send(msg: ParentMessage): void {
    if (traceEnabled) {
      trace("frame.out", {
        frame: msg.type,
        id: "id" in msg ? msg.id : undefined,
        rid: "rid" in msg ? msg.rid : undefined,
      });
    }
    // Never write to a corpse. The write would fail asynchronously and, historically, take the
    // host process with it; even with the stdin 'error' listener in place there is nothing to
    // gain. MUST NOT throw — `reply()` calls this from serviceInterrupt's catch, where a throw
    // would become an unhandled rejection, trading one crash for another.
    if (!this.workerAlive) {
      this.appendStderr(`[rlm] dropped '${msg.type}' frame: worker ${this.exitDescription()}\n`);
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /**
   * Listener counts on the worker's stdio pipes. Exposed for tests.
   *
   * The `'error'` listener on each is load-bearing: an EventEmitter `'error'` with no listener is
   * an uncaughtException, so a failed write to a dead worker's stdin kills the HOST process. That
   * cannot be behaviour-tested reliably — whether the write reaches the syscall depends on
   * whether node has reaped the child yet — so the invariant is asserted structurally.
   */
  get pipeErrorListenerCounts(): Readonly<Record<"stdin" | "stdout" | "stderr", number>> {
    return Object.freeze({
      stdin: this.proc.stdin.listenerCount("error"),
      stdout: this.proc.stdout.listenerCount("error"),
      stderr: this.proc.stderr.listenerCount("error"),
    });
  }

  /** False once the worker is gone — exited, signalled, or its stdin torn down. */
  private get workerAlive(): boolean {
    return this.proc.exitCode === null
      && this.proc.signalCode === null
      && this.proc.stdin.writable;
  }

  /** How the worker went away, for diagnostics. */
  private exitDescription(): string {
    if (this.proc.signalCode !== null) return `killed by ${this.proc.signalCode}`;
    if (this.proc.exitCode !== null) return `exited with code ${this.proc.exitCode}`;
    return "stdin closed";
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n", this.scanOffset)) >= 0) {
      const line = this.buf.slice(this.scanOffset, nl).trim();
      this.scanOffset = nl + 1;
      if (line) {
        try {
          const message = JSON.parse(line) as unknown;
          if (isWorkerMessage(message)) this.dispatch(message);
          else this.appendStderr(`\n[protocol] skipped invalid stdout message: ${line.slice(0, 200)}`);
        } catch {
          // Non-JSON line on the protocol stream — likely a subprocess writing to fd 1.
          // Skip it so a rogue write doesn't kill the pump, but retain a breadcrumb for watchdog errors.
          this.appendStderr(`\n[protocol] skipped non-JSON stdout line: ${line.slice(0, 200)}`);
        }
      }
    }
    // Drop the processed prefix to avoid O(n²) growth across chunks.
    if (this.scanOffset > 0) {
      this.buf = this.buf.slice(this.scanOffset);
      this.scanOffset = 0;
    }
  }

  private dispatch(msg: WorkerMessage): void {
    if (traceEnabled) {
      if (isInterrupt(msg)) {
        trace("frame.in", {
          frame: msg.type,
          rid: msg.rid,
          depth: msg.depth,
          detached: msg.detached === true,
          prompts: "prompts" in msg ? msg.prompts?.length : 1,
        });
      } else {
        trace("frame.in", { frame: "response", id: msg.id, ok: msg.ok });
      }
    }
    if (isInterrupt(msg)) {
      this.touchPending();
      void serviceInterrupt(msg, this.handlers, (rid, body) => this.reply(rid, body));
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  private reply(rid: string, body: ReplyBody): void {
    if (!this.disposed) this.send({ type: "llm_reply", rid, ...body });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
