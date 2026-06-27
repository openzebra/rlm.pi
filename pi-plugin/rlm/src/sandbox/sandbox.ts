/**
 * PythonSandbox — owns one `python3 worker.py` subprocess and the JSONL stdio pump.
 *
 * The pump multiplexes two concerns on one pipe:
 *   1. request/response (exec, load_context, shutdown), keyed by `id`;
 *   2. mid-exec sub-LLM interrupts (llm_query/rlm_query), serviced in-process by handlers
 *      the engine/bridge installs — the worker never sees API keys.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInterrupt,
  isWorkerMessage,
  type AskAnswer,
  type AskQuestion,
  type ParentMessage,
  type ReplResult,
  type WorkerInterrupt,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import { formatError } from "../util/errors.ts";

/** Handlers the bridge installs to service sub-LLM interrupts. Return the reply payload. */
export interface SubLlmHandlers {
  llmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  llmQueryBatched(prompts: readonly string[], model: string | null, depth: number): Promise<string[]>;
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: readonly string[], model: string | null, depth: number): Promise<string[]>;
  advancePhase(phase: string, summary: string | undefined, depth: number): Promise<string>;
  askUserQuestion(questions: readonly AskQuestion[], depth: number): Promise<AskAnswer[]>;
  todo(action: string, params: Record<string, unknown>, depth: number): Promise<string>;
}

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
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker.py");
const TODO_PROTO_KEYS = new Set(["type", "rid", "depth", "action"]);

// The sandbox runs untrusted model-authored code; it must never inherit provider secrets.
const SENSITIVE_ENV = /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|_KEY$/i;

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SENSITIVE_ENV.test(k)) env[k] = v;
  }
  return env;
}

const REJECT: SubLlmHandlers = {
  llmQuery: async () => formatError("sub-LLM bridge not configured"),
  llmQueryBatched: async (p) => p.map(() => formatError("sub-LLM bridge not configured")),
  rlmQuery: async () => formatError("sub-LLM bridge not configured"),
  rlmQueryBatched: async (p) => p.map(() => formatError("sub-LLM bridge not configured")),
  advancePhase: async () => formatError("phase advancement not available"),
  askUserQuestion: async (questions) => questions.map((q) => ({
    question: q.question,
    selected: [],
    custom: formatError("ask_user_question not configured"),
  })),
  todo: async () => formatError("todo not configured"),
};

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
  private stderr = "";
  private disposed = false;
  private ready: Promise<void>;

  private constructor(opts: SandboxOptions) {
    this.handlers = { ...REJECT, ...opts.handlers };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20 * 60_000;
    this.initTimeoutMs = opts.initTimeoutMs ?? 30_000;
    const python = opts.python ?? "python3";
    this.proc = spawn(
      python,
      ["-u", WORKER_PATH, "--depth", String(opts.depth ?? 1), "--timeout", String(opts.execTimeoutS ?? 600)],
      { stdio: ["pipe", "pipe", "pipe"], env: sanitizedEnv() },
    ) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      const hint = err.code === "ENOENT" ? ` ('${python}' not found — is Python installed and on PATH?)` : "";
      this.failAll(new Error(`failed to start sandbox${hint}: ${err.message}`));
    });
    this.proc.on("exit", () => this.failAll(new Error(`worker exited; stderr=${this.stderr.trim()}`)));

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

  async loadContext(payload: unknown, index?: number): Promise<number> {
    const isJson = typeof payload !== "string";
    let path: string | undefined;
    try {
      path = await this.writeContextFile(payload, isJson);
      const res = await this.request({ type: "load_context", path, index, json: isJson });
      return res.index ?? 0;
    } finally {
      if (path) await unlink(path).catch(() => {});
    }
  }

  private async writeContextFile(payload: unknown, isJson: boolean): Promise<string> {
    const file = join(
      tmpdir(),
      `rlm-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${isJson ? "json" : "txt"}`,
    );
    try {
      await writeFile(file, isJson ? JSON.stringify(payload) : (payload as string));
    } catch (e) {
      await unlink(file).catch(() => {});
      throw e;
    }
    return file;
  }

  async exec(code: string): Promise<ReplResult> {
    const res = await this.request({ type: "exec", code });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      finalAnswer: res.final_answer ?? null,
      answerContent: res.answer_content ?? "",
      edits: res.edits ?? [],
      diffs: res.diffs ?? [],
      raised: res.raised ?? false,
      executionTimeMs: Math.round((res.execution_time ?? 0) * 1000),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.send({ id: "_shutdown", type: "shutdown" });
    } catch {
      /* pipe may already be gone */
    }
    await new Promise((r) => setTimeout(r, 50));
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    this.failAll(new Error("sandbox disposed"));
  }

  /** Pickle the worker's user namespace atomically to path (rename .tmp \u2192 final inside worker). */
  async snapshot(path: string, nonce: string): Promise<boolean> {
    try {
      const res = await this.request({ type: "snapshot", path, nonce });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Restore user variables. Worker verifies session nonce before deserializing. */
  async restore(path: string, nonce: string): Promise<boolean> {
    try {
      const res = await this.request({ type: "restore", path, nonce });
      return res.ok;
    } catch {
      return false;
    }
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

  private request(payload: RequestBody): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new Error("sandbox disposed"));
    const id = `r${++this.seq}`;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = this.createWatchdog(id, payload.type, reject);
      this.pending.set(id, { resolve, reject, timer, requestType: payload.type });
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

  private send(msg: ParentMessage): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
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
          else this.stderr = `${this.stderr}\n[protocol] skipped invalid stdout message: ${line.slice(0, 200)}`.slice(-8192);
        } catch {
          // Non-JSON line on the protocol stream — likely a subprocess writing to fd 1.
          // Skip it so a rogue write doesn't kill the pump, but retain a breadcrumb for watchdog errors.
          this.stderr = `${this.stderr}\n[protocol] skipped non-JSON stdout line: ${line.slice(0, 200)}`.slice(-8192);
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
    if (isInterrupt(msg)) {
      this.touchPending();
      void this.serviceInterrupt(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  private async serviceInterrupt(msg: WorkerInterrupt): Promise<void> {
    const h = this.handlers;
    const d = msg.depth;
    try {
      if (msg.type === "llm_query") {
        const response = await h.llmQuery(msg.prompt ?? "", msg.model ?? null, d);
        this.reply(msg.rid, { response });
      } else if (msg.type === "rlm_query") {
        const response = await h.rlmQuery(msg.prompt ?? "", msg.model ?? null, d);
        this.reply(msg.rid, { response });
      } else if (msg.type === "llm_query_batched") {
        const responses = await h.llmQueryBatched(msg.prompts ?? [], msg.model ?? null, d);
        this.reply(msg.rid, { responses });
      } else if (msg.type === "rlm_query_batched") {
        const responses = await h.rlmQueryBatched(msg.prompts ?? [], msg.model ?? null, d);
        this.reply(msg.rid, { responses });
      } else if (msg.type === "advance_phase") {
        const response = await h.advancePhase(msg.phase ?? "", msg.summary, d);
        this.reply(msg.rid, { response });
      } else if (msg.type === "ask_user_question") {
        const answers = await h.askUserQuestion(msg.questions ?? [], d);
        this.reply(msg.rid, { answers });
      } else if (msg.type === "todo") {
        const params = Object.fromEntries(
          Object.entries(msg).filter(([key]) => !TODO_PROTO_KEYS.has(key)),
        );
        const response = await h.todo(msg.action ?? "list", params, d);
        this.reply(msg.rid, { response });
      }
    } catch (err) {
      this.reply(msg.rid, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private reply(rid: string, body: { response?: string; responses?: string[]; answers?: AskAnswer[]; error?: string }): void {
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
