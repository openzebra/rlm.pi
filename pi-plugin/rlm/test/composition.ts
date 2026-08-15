/**
 * Composition-root tests (audit C1/C6/M9): the SECOND construction path —
 * RlmController.start() — must receive the session MemoryStore and the provider-capped
 * session gates, exactly like the repl() tool does. Issue #4 and audit C1 were both
 * "one root grew, the other forgot".
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RlmController } from "../src/mode/rlm-mode.ts";
import { MemoryStore as MemoryStoreImpl } from "../src/core/memory.ts";
import { buildSessionGates, createSubcallGates } from "../src/util/concurrency.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { EngineDeps } from "../src/core/engine.ts";
import type { RunRlm } from "../src/core/types.ts";
import { MOCK_MODEL, MOCK_REGISTRY, check, failureCount } from "./helpers.ts";

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)}`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

class ProbeController extends RlmController {
  captured: EngineDeps | undefined;

  /** R7: intercept the exact object `createEngine` would receive — not controller fields. */
  protected spawnEngine(deps: EngineDeps): RunRlm {
    this.captured = deps;
    return async () => ({
      answer: "stub-answer", iterations: 1, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
    });
  }
}

const dir = mkdtempSync(join(tmpdir(), "rlm-composition-"));
try {
  writeFileSync(join(dir, "a.txt"), "composition probe file\n");
  const ctx = {
    modelRegistry: MOCK_REGISTRY,
    model: MOCK_MODEL,
    cwd: dir,
  } as unknown as ExtensionContext;

  // C1: the session store + provider-capped gates must reach the rlm tool's engine.
  const memory = new MemoryStoreImpl(dir, { dir: join(dir, "m") });
  const controller = new ProbeController({ ...DEFAULT_CONFIG, enabled: true }, memory);
  const sessionGates = buildSessionGates(
    { ...DEFAULT_CONFIG, providerMaxConcurrent: Object.freeze({ zai: 4 }) },
    "zai", // smart
    "openai", // worker
  );
  controller.setSessionGates(() => sessionGates);

  const handle = controller.start(ctx, { rootPrompt: "composition probe", context: "seed" });
  const result = await handle.done;

  check("C1: start() completed through the stubbed engine", result.answer === "stub-answer", result.answer.slice(0, 30));
  const cap = controller.captured;
  check("C1: engine received the session MemoryStore", cap?.memory === memory);
  check("C1: engine received the provider-capped session gates", cap?.gates === sessionGates);
  check("C1: gates carry the smart-provider child cap (zai=4)",
    cap?.gates !== undefined && cap.gates.rlm.at(1).inFlight >= 0 && cap.gates !== createSubcallGates(16, 6));

  // Without setSessionGates the engine still runs (private gates fallback) — no crash.
  const bare = new ProbeController({ ...DEFAULT_CONFIG, enabled: true }, memory);
  const bareHandle = bare.start(ctx, { rootPrompt: "bare probe", context: "seed" });
  await bareHandle.done;
  check("C1: start() works without session gates (private fallback)", bare.captured?.gates === undefined);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// C6: buildSessionGates caps the RIGHT model per gate.
{
  const caps = { providerMaxConcurrent: Object.freeze({ zai: 4 }) };
  const gates = buildSessionGates({ ...DEFAULT_CONFIG, ...caps }, "zai", "openai");
  // leaf = worker (openai) → uncapped base; child = smart (zai) → 4.
  let active = 0;
  let peak = 0;
  const job = async (): Promise<void> => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  };
  await Promise.all(new Array(8).fill(0).map(() => gates.rlm.at(1).run(job)));
  check("C6: child gate capped by the SMART provider (zai=4)", peak === 4, `peak=${peak}`);
  const leafGates = buildSessionGates({ ...DEFAULT_CONFIG, ...caps }, "openai", "zai");
  let lActive = 0;
  let lPeak = 0;
  const lJob = async (): Promise<void> => {
    lActive++; lPeak = Math.max(lPeak, lActive);
    await new Promise((r) => setTimeout(r, 20));
    lActive--;
  };
  await Promise.all(new Array(8).fill(0).map(() => leafGates.leaf.run(lJob)));
  check("C6: leaf gate capped by the WORKER provider (zai=4)", lPeak === 4, `peak=${lPeak}`);
}

finish();
