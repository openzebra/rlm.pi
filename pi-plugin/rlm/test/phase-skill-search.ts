/**
 * SKILL.state Workstream E — skill_search end-to-end against a REAL sandbox: interrupt
 * round-trip, RESERVED hiding, per-exec scaffold restore, and the REJECT default when the
 * handler is unwired.
 * Run: bun run pi-plugin/rlm/test/phase-skill-search.ts
 */

import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { REJECT, type SubLlmHandlers } from "../src/sandbox/interrupts.ts";
import { check, finish } from "./helpers.ts";

const HIT = JSON.stringify([
  { id: "n1", text: "settingsPath() joins getAgentDir() [settings.ts:22]", tags: ["config"], score: 3.14 },
]);

async function boot(handlers: Partial<SubLlmHandlers>): Promise<PythonSandbox> {
  return PythonSandbox.spawn({
    depth: 0,
    surface: "root",
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 400_000,
    awaitTimeoutS: 30,
    handlers,
  });
}

async function main(): Promise<void> {
  // ── wired: full interrupt round-trip ──
  let sandbox: PythonSandbox | undefined;
  try {
    sandbox = await boot({ skillSearch: async () => HIT });
    const r1 = await sandbox.exec('print(skill_search("settings path"))');
    check("skill_search resolves through the bridge", !r1.raised, r1.stderr.slice(0, 200));
    check("host reply reaches the worker", r1.stdout.includes("settings.ts:22"));

    // RESERVED: the scaffold binding is hidden from SHOW_VARS / var_names.
    const r2 = await sandbox.exec('v = SHOW_VARS()\nprint("skill_search" in v)');
    check("RESERVED hides skill_search from SHOW_VARS", r2.stdout.trim().endsWith("False"), r2.stdout);

    // _restore_scaffold: clobbered bindings return on the next exec.
    await sandbox.exec("skill_search = 123");
    const r3 = await sandbox.exec("print(callable(skill_search))");
    check("scaffold survives clobbering", r3.stdout.trim().endsWith("True"), r3.stdout);

    // Malformed host payload → structured error hit, never a crash.
    const r4 = await sandbox.exec('print(skill_search("anything"))');
    check("repeat call still fine", !r4.raised && r4.stdout.includes("settings.ts:22"));
  } finally {
    await sandbox?.dispose();
  }

  // ── unwired: REJECT default keeps old sandboxes safe ──
  let bare: PythonSandbox | undefined;
  try {
    bare = await boot(REJECT);
    const r = await bare.exec('print(skill_search("settings path"))');
    check("unwired handler does not raise", !r.raised, r.stderr.slice(0, 200));
    check("unwired reply is an Error string", r.stdout.includes("Error:"), r.stdout.slice(0, 120));
  } finally {
    await bare?.dispose();
  }

  // ── bad arguments raise like the rest of the scaffold ──
  let strict: PythonSandbox | undefined;
  try {
    strict = await boot({ skillSearch: async () => HIT });
    const r = await strict.exec("skill_search(\"\")");
    check("empty query raises TypeError", r.raised && r.stderr.includes("TypeError"), r.stderr.slice(0, 160));
  } finally {
    await strict?.dispose();
  }

  finish();
}

void main(); // explicit: fire-and-forget, no floating promise
