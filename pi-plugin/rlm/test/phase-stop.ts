/**
 * phase-stop — /rlm-stop plumbing: raceAbort signal composition and the stop
 * command's contract (RLM-mode abort + native stop callback → one message).
 * No TUI, no sandbox.
 */

import { check, failureCount } from "./helpers.ts";
import { raceAbort } from "../src/util/abort.ts";
import { registerRlmCommand } from "../src/commands/rlm.ts";
import type { RlmController } from "../src/mode/rlm-mode.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── raceAbort: fires on either input, survives both alive, no listener leaks after dispose ──
{
  const a = new AbortController();
  const b = new AbortController();
  const raced = raceAbort(a.signal, b.signal);
  check("race: combined signal present", raced.signal !== undefined);
  check("race: alive while both alive", raced.signal?.aborted === false);
  a.abort("stop-a");
  check("race: fires on first input", raced.signal?.aborted === true && raced.signal?.reason === "stop-a");
  raced.dispose();

  const c = new AbortController();
  const d = new AbortController();
  const raced2 = raceAbort(c.signal, d.signal);
  d.abort("stop-b");
  check("race: fires on second input", raced2.signal?.aborted === true && raced2.signal?.reason === "stop-b");
  raced2.dispose();

  const e = new AbortController();
  e.abort("pre");
  const raced3 = raceAbort(e.signal, new AbortController().signal);
  check("race: pre-aborted input aborts immediately", raced3.signal?.aborted === true && raced3.signal?.reason === "pre");
  raced3.dispose();

  // After dispose, aborting an input must NOT reach the combined signal (listener detached).
  const f = new AbortController();
  const g = new AbortController();
  const raced4 = raceAbort(f.signal, g.signal);
  raced4.dispose();
  f.abort("late");
  check("race: dispose detaches relays", raced4.signal?.aborted === false);

  // Single/absent inputs pass through without machinery.
  const only = new AbortController();
  check("race: single input passthrough", raceAbort(only.signal, undefined).signal === only.signal);
  check("race: no inputs → undefined signal", raceAbort(undefined, undefined).signal === undefined);
}

// ── /rlm-stop: aborts RLM runs AND native work; message reflects what was stopped ──
{
  const makePi = (): { readonly pi: ExtensionAPI; readonly handlers: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>> } => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const pi = {
      registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void => {
        handlers.set(name, def.handler);
      },
      registerShortcut: (): void => {},
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  };
  const makeCtx = (): { readonly ctx: ExtensionContext; readonly messages: string[] } => {
    const messages: string[] = [];
    const ctx = { ui: { notify: (m: string): void => { messages.push(m); } } } as unknown as ExtensionContext;
    return { ctx, messages };
  };

  // RLM-mode run only.
  {
    const { pi, handlers } = makePi();
    let aborted = 0;
    const controller = {
      isBusy: () => aborted === 0,
      abort: () => { aborted += 1; },
    } as unknown as RlmController;
    registerRlmCommand(pi, controller);
    const stop = handlers.get("rlm-stop");
    check("stop: command registered", stop !== undefined);
    const { ctx, messages } = makeCtx();
    await stop?.("", ctx);
    check("stop: RLM-mode run aborted", aborted === 1);
    check("stop: message says work was stopped", messages[0]?.includes("aborted") === true);
  }

  // Native work only (controller idle, stopNative reports in-flight repl/bg work).
  {
    const { pi, handlers } = makePi();
    let aborted = 0;
    const controller = {
      isBusy: () => false,
      abort: () => { aborted += 1; },
    } as unknown as RlmController;
    let nativeStopped = 0;
    registerRlmCommand(pi, controller, () => { nativeStopped += 1; return true; });
    const { ctx, messages } = makeCtx();
    await handlers.get("rlm-stop")?.("", ctx);
    check("stop: native stop invoked, RLM controller untouched", nativeStopped === 1 && aborted === 0);
    check("stop: native-only stop still reports success", messages[0]?.includes("aborted") === true);
  }

  // Nothing in flight.
  {
    const { pi, handlers } = makePi();
    const controller = { isBusy: () => false, abort: (): void => {} } as unknown as RlmController;
    registerRlmCommand(pi, controller, () => false);
    const { ctx, messages } = makeCtx();
    await handlers.get("rlm-stop")?.("", ctx);
    check("stop: idle session reports nothing to stop", messages[0]?.includes("No RLM work in progress") === true);
  }
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
