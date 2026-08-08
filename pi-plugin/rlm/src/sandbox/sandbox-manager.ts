/**
 * SandboxManager — persistent singleton owning one PythonSandbox across
 * multiple repl() calls. Handles lazy creation, death-recreate, serialized
 * execution via a promise queue, and idempotent disposal.
 */

import { PythonSandbox, type SubLlmHandlers } from "./sandbox.ts";
import type { ReplResult } from "./protocol.ts";
import { mergeLibraryIntoContext } from "../context/library-context.ts";

/** Static configuration for sandbox creation — set once, reused across getOrCreate calls. */
export interface SandboxManagerConfig {
  readonly execTimeoutS: number;
  readonly requestTimeoutMs: number;
  readonly python: string;
  readonly sandboxInitTimeoutMs: number;
  readonly maxPromptChars: number;
  /** Max seconds the worker waits for a host reply while parked in rlm_await. */
  readonly awaitTimeoutS: number;
  readonly signal?: AbortSignal;
  readonly onSandboxDiscarded?: () => void;
}

export class SandboxManager {
  private sandbox: PythonSandbox | null = null;
  private disposed = false;
  private initPromise: Promise<PythonSandbox> | null = null;
  /** Serialized execution queue — concurrent repl() calls wait for predecessor. */
  private execQueue: Promise<void> = Promise.resolve();
  private pendingExecCount = 0;
  /** Context payload to load on first sandbox creation. Set externally before getOrCreate. */
  contextPayload: unknown = null;
  /** True once contextPayload has been loaded into the sandbox (prevents reload + race fix). */
  private contextLoaded = false;

  constructor(private readonly config: SandboxManagerConfig) {}

  /**
   * Append a library payload to the context this manager replays on death-recreate.
   *
   * The live worker has ALREADY appended it in-process (worker.py `_append_library`), so this
   * deliberately does not reload — it only keeps the host's replay copy truthful. Without it a
   * recreate silently rolls the sandbox back to a repo-only context, and any child inheriting
   * this payload would never see the library. Dedups by `lib/<id>/` prefix.
   */
  appendLibrary(payload: unknown): void {
    this.contextPayload = mergeLibraryIntoContext(this.contextPayload, payload);
  }

  /**
   * Lazy get-or-create the sandbox. On first call, spawns PythonSandbox with the
   * given handlers. Subsequent calls return the existing sandbox immediately.
   * Deduplicates concurrent calls via initPromise.
   *
   * If contextPayload is set, it is loaded before the sandbox is returned.
   */
  async getOrCreate(handlers: Partial<SubLlmHandlers>): Promise<PythonSandbox> {
    if (this.disposed) throw new Error("SandboxManager disposed");
    if (this.sandbox) {
      // RACE FIX: contextPayload may arrive after the sandbox was created (the
      // "context" event's async packRepository resolves after the first repl() call).
      // Load it into the live sandbox now if still pending.
      if (this.contextPayload !== null && !this.contextLoaded) {
        await this.sandbox.loadContext(this.contextPayload);
        this.contextLoaded = true;
      }
      return this.sandbox;
    }

    if (this.initPromise) return this.initPromise;

    this.initPromise = PythonSandbox.spawn({
      execTimeoutS: this.config.execTimeoutS,
      requestTimeoutMs: this.config.requestTimeoutMs,
      python: this.config.python,
      signal: this.config.signal,
      initTimeoutMs: this.config.sandboxInitTimeoutMs,
      maxPromptChars: this.config.maxPromptChars,
      awaitTimeoutS: this.config.awaitTimeoutS,
      handlers,
    }).then(async (s) => {
      // Load context on first creation if available.
      if (this.contextPayload !== null) {
        await s.loadContext(this.contextPayload);
        this.contextLoaded = true;
      }
      this.sandbox = s;
      this.initPromise = null;
      return s;
    }).catch((err) => {
      this.contextLoaded = false;
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  /**
   * Execute code in the sandbox with no per-invocation setup. Serializes concurrent calls via
   * a promise queue (second call waits for the first, no interleaving). On failure the sandbox
   * is nullified so the next call recreates it (death-recreate).
   */
  async exec(code: string, signal?: AbortSignal): Promise<ReplResult> {
    return this.execQueued(code, undefined, signal);
  }

  /**
   * Execute code after running `setup` inside the serialized execution slot, so per-invocation
   * handler state (emitter, limits, depth) always matches the active REPL run.
   */
  async execWithSetup(code: string, setup: () => void, signal?: AbortSignal): Promise<ReplResult> {
    return this.execQueued(code, setup, signal);
  }

  private async execQueued(code: string, setup?: () => void, signal?: AbortSignal): Promise<ReplResult> {
    if (!this.sandbox) throw new Error("Sandbox not initialized — call getOrCreate first");

    // Serialize: queue behind any in-flight execution
    const prev = this.execQueue;
    let resolveNext: () => void = () => {};
    this.execQueue = new Promise<void>((r) => { resolveNext = r; });
    this.pendingExecCount++;
    await prev;

    try {
      const sandbox = this.sandbox;
      if (!sandbox) throw new Error("Sandbox not initialized — previous execution disposed it");
      setup?.();
      return await sandbox.exec(code, signal);
    } catch (err) {
      // Death-recreate: worker died — nullify so next repl() recreates
      if (this.sandbox) {
        // Best-effort dispose of the dead sandbox
        try { await this.sandbox.dispose(); } catch { /* already dead */ }
        this.sandbox = null;
        this.contextLoaded = false;
        this.config.onSandboxDiscarded?.();
      }
      throw err;
    } finally {
      this.pendingExecCount--;
      resolveNext();
    }
  }

  /**
   * Keep the live sandbox's request watchdog from firing while it is legitimately idle.
   *
   * The watchdog only refreshes on frames arriving at THIS sandbox, but a detached
   * rlm_query child does its work in its own sandbox — so without a heartbeat a healthy
   * long-running child would trip death-recreate and destroy the REPL namespace.
   */
  refreshWatchdog(): void {
    this.sandbox?.refreshWatchdog();
  }

  /** True if the sandbox is alive and not disposed. */
  get isAlive(): boolean {
    return this.sandbox !== null && !this.disposed;
  }

  /** True if a repl() execution is currently in-flight or queued. */
  get isExecuting(): boolean {
    return this.pendingExecCount > 0;
  }

  /** Idempotent dispose. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.sandbox?.dispose();
    if (this.sandbox !== null) {
      this.sandbox = null;
      this.contextLoaded = false;
      this.config.onSandboxDiscarded?.();
    }
  }
}
