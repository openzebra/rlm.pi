/**
 * PythonSandbox — owns one `python3 worker.py` subprocess and the JSONL stdio pump.
 *
 * The pump multiplexes two concerns on one pipe:
 *   1. request/response (exec, load_context, bootstrap, shutdown), keyed by `id`;
 *   2. mid-exec sub-LLM interrupts (llm_query/rlm_query), serviced in-process by handlers
 *      the engine/bridge installs — the worker never sees API keys.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInterrupt,
  type ParentMessage,
  type ReplResult,
  type WorkerInterrupt,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";

/** Handlers the bridge installs to service sub-LLM interrupts. Return the reply payload. */
export interface SubLlmHandlers {
  llmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  llmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

export interface SandboxOptions {
  /** Sandbox recursion depth label (passed to the worker, used in interrupt routing). */
  depth?: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  execTimeoutS?: number;
  /** Parent-side watchdog per request (ms); on breach the worker is SIGKILLed. */
  requestTimeoutMs?: number;
  /** Python executable. */
  python?: string;
  /** Handlers for sub-LLM interrupts. Defaults reject (Phase 1 has no bridge yet). */
  handlers?: Partial<SubLlmHandlers>;
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker.py");

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
  llmQuery: async () => "Error: sub-LLM bridge not configured",
  llmQueryBatched: async (p) => p.map(() => "Error: sub-LLM bridge not configured"),
  rlmQuery: async () => "Error: sub-LLM bridge not configured",
  rlmQueryBatched: async (p) => p.map(() => "Error: sub-LLM bridge not configured"),
};

/** Distributive omit so each union member keeps its own fields (plain Omit collapses to shared keys). */
type RequestBody = WorkerRequest extends infer T ? (T extends { id: string } ? Omit<T, "id"> : never) : never;

interface Pending {
  resolve(res: WorkerResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PythonSandbox {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers: SubLlmHandlers;
  private readonly requestTimeoutMs: number;
  private stderr = "";
  private disposed = false;
  private ready: Promise<void>;

  private constructor(private readonly opts: SandboxOptions) {
    this.handlers = { ...REJECT, ...opts.handlers };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20 * 60_000;
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
  }

  /** Spawn a sandbox and wait until the worker reports it is initialized. */
  static async spawn(opts: SandboxOptions = {}): Promise<PythonSandbox> {
    const sandbox = new PythonSandbox(opts);
    await sandbox.ready;
    return sandbox;
  }

  setHandlers(handlers: Partial<SubLlmHandlers>): void {
    Object.assign(this.handlers, handlers);
  }

  async loadContext(payload: unknown, index?: number): Promise<number> {
    const res = await this.request({ type: "load_context", payload, index });
    return res.index ?? 0;
  }

  async bootstrap(code: string): Promise<void> {
    if (code.trim()) await this.request({ type: "bootstrap", code });
  }

  async exec(code: string): Promise<ReplResult> {
    const res = await this.request({ type: "exec", code });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      finalAnswer: res.final_answer ?? null,
      executionTimeMs: Math.round((res.execution_time ?? 0) * 1000),
      localsKeys: res.locals_keys ?? [],
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

  // ---- internals ------------------------------------------------------------------------

  private waitForInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not start in time")), 30_000);
      this.pending.set("_init", {
        resolve: (res) => {
          clearTimeout(timer);
          res.ok ? resolve() : reject(new Error(res.error ?? "worker init failed"));
        },
        reject,
        timer,
      });
    });
  }

  private request(payload: RequestBody): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new Error("sandbox disposed"));
    const id = `r${++this.seq}`;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.proc.kill("SIGKILL");
        reject(new Error(`request '${payload.type}' exceeded watchdog (${this.requestTimeoutMs}ms); worker killed`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, ...payload } as ParentMessage);
    });
  }

  private send(msg: ParentMessage): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(JSON.parse(line) as WorkerMessage);
    }
  }

  private dispatch(msg: WorkerMessage): void {
    if (isInterrupt(msg)) {
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
      } else {
        const responses = await h.rlmQueryBatched(msg.prompts ?? [], msg.model ?? null, d);
        this.reply(msg.rid, { responses });
      }
    } catch (err) {
      this.reply(msg.rid, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private reply(rid: string, body: { response?: string; responses?: string[]; error?: string }): void {
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
