/**
 * RLM trace — one JSONL line per interesting event, for the E2E harness and for post-mortem of
 * a hung run. Off unless RLM_TRACE_FILE is set; when off, every call costs one boolean check.
 *
 * Purely observational: it subscribes to the RlmEmitter that already exists and to the sandbox
 * frames that already cross the pipe. No behaviour is duplicated here.
 */
import { appendFileSync } from "node:fs";
import type { RlmEmitter } from "../tool/rlm-events.ts";

const FILE = process.env.RLM_TRACE_FILE;

/** Check this before building payloads on hot paths. */
export const traceEnabled: boolean = typeof FILE === "string" && FILE.length > 0;

const START = Date.now();

/** Append one event. Fail-soft: tracing must never break a run (state/writes.ts convention). */
export function trace(kind: string, data: Record<string, unknown> = {}): void {
  if (!traceEnabled || FILE === undefined) return;
  const now = Date.now();
  try {
    appendFileSync(FILE, `${JSON.stringify({ t: now, rel: now - START, pid: process.pid, kind, ...data })}\n`);
  } catch {
    /* ignore */
  }
}

/** Mirror one emitter's sub-call lifecycle into the trace. Returns an unsubscribe fn. */
export function attachTracer(emitter: RlmEmitter, scope: "turn" | "background"): () => void {
  if (!traceEnabled) return () => {};
  // Rename e.kind → subcallKind so it does not overwrite the outer event kind
  // (`subcall.created` / `subcall.updated`) when `trace` spreads `data` after `kind`.
  const offs = [
    emitter.onSubcallCreated((e) => {
      const { kind: subcallKind, ...rest } = e;
      trace("subcall.created", { scope, subcallKind, ...rest });
    }),
    emitter.onSubcallUpdated((e) => trace("subcall.updated", { scope, ...e })),
  ];
  return () => { for (const off of offs) off(); };
}
