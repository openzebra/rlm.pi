/**
 * Phase 4 (v5 port): provider-aware concurrency caps.
 * Gate math: effective leaf/child limits, unknown-provider passthrough, real serialization
 * under a { zai: 4 } style cap.
 */

import { check, failureCount } from "./helpers.ts";
import {
  DepthGates,
  effectiveChildLimit,
  effectiveSubcallLimit,
  Semaphore,
} from "../src/util/concurrency.ts";
import { validateConfig } from "../src/config/settings.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

// ── gate math ───────────────────────────────────────────────────────────────────

{
  const base = { ...DEFAULT_CONFIG };
  check("leaf: no caps → base limit", effectiveSubcallLimit(base, ["openai"]) === base.maxConcurrentSubcalls);

  const zai = { ...DEFAULT_CONFIG, providerMaxConcurrent: Object.freeze({ zai: 4 }) };
  check("leaf: zai cap lowers the gate", effectiveSubcallLimit(zai, ["zai"]) === 4);
  check("leaf: unaffected provider keeps the base", effectiveSubcallLimit(zai, ["openai"]) === DEFAULT_CONFIG.maxConcurrentSubcalls);
  check("leaf: mixed providers → the strictest cap wins",
    effectiveSubcallLimit(zai, ["openai", "zai"]) === 4);
  check("leaf: unknown providers ignored", effectiveSubcallLimit(zai, ["mystery"]) === DEFAULT_CONFIG.maxConcurrentSubcalls);

  const tighter = { ...DEFAULT_CONFIG, providerMaxConcurrent: Object.freeze({ zai: 64 }) };
  check("leaf: a cap above the base never RAISES the limit",
    effectiveSubcallLimit(tighter, ["zai"]) === DEFAULT_CONFIG.maxConcurrentSubcalls);

  check("child: provider cap lowers child gate", effectiveChildLimit(zai, "zai") === 4);
  check("child: other provider keeps base", effectiveChildLimit(zai, "openai") === DEFAULT_CONFIG.maxConcurrentChildren);
  check("child: cap above base keeps base", effectiveChildLimit(tighter, "zai") === DEFAULT_CONFIG.maxConcurrentChildren);
  check("child: no caps → base", effectiveChildLimit(base, "zai") === DEFAULT_CONFIG.maxConcurrentChildren);
}

// ── settings validation ─────────────────────────────────────────────────────────

{
  const cfg = validateConfig({
    providerMaxConcurrent: { zai: 4, bogus: "x", neg: -1, openai: 8 },
  });
  const caps = cfg.providerMaxConcurrent;
  check("settings: valid caps parsed", caps?.zai === 4 && caps?.openai === 8, JSON.stringify(caps));
  check("settings: non-numeric + negative entries dropped", caps !== undefined && !("bogus" in caps) && !("neg" in caps));
  check("settings: absent key stays undefined", validateConfig({}).providerMaxConcurrent === undefined);
}

// ── real serialization under a provider cap ─────────────────────────────────────

{
  // A semaphore with limit 4 (the {zai:4} cap) must serialize the 5th concurrent run.
  const sem = new Semaphore(effectiveSubcallLimit(
    { ...DEFAULT_CONFIG, providerMaxConcurrent: Object.freeze({ zai: 4 }) },
    ["zai"],
  ));
  let active = 0;
  let peak = 0;
  const job = async (): Promise<void> => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 25));
    active--;
  };
  await Promise.all(new Array(8).fill(0).map(() => sem.run(job)));
  check("semaphore: provider-capped gate bounds concurrency at 4", peak === 4, `peak=${peak}`);

  // DepthGates: per-depth independence still holds with the capped child limit.
  const gates = new DepthGates(effectiveChildLimit(
    { ...DEFAULT_CONFIG, providerMaxConcurrent: Object.freeze({ zai: 3 }) },
    "zai",
  ));
  let d0 = 0;
  let d1 = 0;
  await Promise.all([
    gates.at(1).run(async () => { d0++; await new Promise((r) => setTimeout(r, 20)); }),
    gates.at(2).run(async () => { d1++; await new Promise((r) => setTimeout(r, 20)); }),
  ]);
  check("depthgates: per-depth gates admit independently (capped)", d0 === 1 && d1 === 1);
}

finish();
