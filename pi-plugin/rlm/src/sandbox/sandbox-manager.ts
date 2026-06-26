/**
 * SandboxManager — persistent singleton owning one PythonSandbox across
 * multiple repl() calls. Handles lazy creation, death-recreate, serialized
 * execution via a promise queue, and idempotent disposal.
 */

import { PythonSandbox, type SubLlmHandlers } from "./sandbox.ts";

/** Static configuration for sandbox creation — set once, reused across getOrCreate calls. */
export interface SandboxManagerConfig {
  execTimeoutS: number;
  requestTimeoutMs: number;
  python: string;
  sandboxInitTimeoutMs: number;
  signal?: AbortSignal;
}

export class SandboxManager {
  private sandbox: PythonSandbox | null = null;
  private disposed = false;
  private initPromise: Promise<PythonSandbox> | null = null;
  /** Serialized execution queue — concurrent repl() calls wait for predecessor. */
  private execQueue: Promise<void> = Promise.resolve();
  private executing = false;
  /** Context payload to load on first sandbox creation. Set externally before getOrCreate. */
  contextPayload: unknown = null;

  constructor(private readonly config: SandboxManagerConfig) {}

  /**
   * Lazy get-or-create the sandbox. On first call, spawns PythonSandbox with the
   * given handlers. Subsequent calls return the existing sandbox immediately.
   * Deduplicates concurrent calls via initPromise.
   *
   * The caller is responsible for calling loadContext() on the returned sandbox
   * before first use.
   */
  async getOrCreate(handlers: Partial<SubLlmHandlers>): Promise<PythonSandbox> {
    if (this.disposed) throw new Error("SandboxManager disposed");
    if (this.sandbox) return this.sandbox;

    if (this.initPromise) return this.initPromise;

    this.initPromise = PythonSandbox.spawn({
      execTimeoutS: this.config.execTimeoutS,
      requestTimeoutMs: this.config.requestTimeoutMs,
      python: this.config.python,
      signal: this.config.signal,
      initTimeoutMs: this.config.sandboxInitTimeoutMs,
      handlers,
    }).then(async (s) => {
      // Load context on first creation if available
      if (this.contextPayload !== null) {
        try { await s.loadContext(this.contextPayload); } catch { /* best-effort */ }
      }
      this.sandbox = s;
      this.initPromise = null;
      return s;
    }).catch((err) => {
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  /**
   * Execute code in the sandbox. Serializes concurrent calls via a promise queue
   * (second call waits for first to complete, no interleaving). On failure,
   * nullifies the sandbox so the next call recreates it (death-recreate).
   */
  async exec(code: string): Promise<import("./protocol.ts").ReplResult> {
    if (!this.sandbox) throw new Error("Sandbox not initialized — call getOrCreate first");

    // Serialize: queue behind any in-flight execution
    const prev = this.execQueue;
    let resolveNext: () => void;
    this.execQueue = new Promise<void>((r) => { resolveNext = r; });
    this.executing = true;
    await prev;

    try {
      return await this.sandbox.exec(code);
    } catch (err) {
      // Death-recreate: worker died — nullify so next repl() recreates
      if (this.sandbox) {
        // Best-effort dispose of the dead sandbox
        try { await this.sandbox.dispose(); } catch { /* already dead */ }
        this.sandbox = null;
      }
      throw err;
    } finally {
      this.executing = false;
      resolveNext!();
    }
  }

  /** True if the sandbox is alive and not disposed. */
  get isAlive(): boolean {
    return this.sandbox !== null && !this.disposed;
  }

  /** True if a repl() execution is currently in-flight or queued. */
  get isExecuting(): boolean {
    return this.executing;
  }

  /** Idempotent dispose. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.sandbox?.dispose();
    this.sandbox = null;
  }
}
