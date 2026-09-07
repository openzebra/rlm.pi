/**
 * R0 enforcement (/tmp/ROOT_FULL_SKILLSTATE_PLAN.md) — the SKILL.state paradigm is operating
 * law: NO rlm.json, command, or UI path can disable any enforced flag. Hostile configs load
 * clean (fail-soft), the override attempt is traced (`skillstate.override-ignored`), the
 * resolved config keeps every flag true, and the config panel exposes no toggle for them.
 *
 * trace.ts snapshots RLM_TRACE_FILE at module load — the env var is set BEFORE the first
 * import of the settings module, then the trace file itself is asserted.
 *
 * Run: bun run pi-plugin/rlm/test/phase-skillstate-enforced.ts
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, finish } from "./helpers.ts";

const TRACE_FILE = join(tmpdir(), `rlm-enforced-trace-${process.pid}.jsonl`);
process.env.RLM_TRACE_FILE = TRACE_FILE;

// Dynamic imports AFTER the env var — module-load order is the whole point here.
const { validateConfig, mergeConfig } = await import("../src/config/settings.ts");
const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");
const { applySetting } = await import("../src/ui/config-panel.ts");
const { trace } = await import("../src/util/trace.ts");

/** The enforced set (R0) — the paradigm, not the calibrations. */
const ENFORCED: readonly string[] = Object.freeze([
  "enableRunState",
  "enableSkillState",
  "enableSkillStateDistill",
  "enableRootContextTransform",
  "enableRootStateFences",
  "enableRootDigestCompaction",
]);

{
  // ── defaults carry the enforced value ──
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  for (const flag of ENFORCED) {
    check(`defaults ${flag} === true`, defaults[flag] === true);
  }
}

{
  // ── hostile config: every enforced flag set false → validator still resolves true ──
  const hostile: Record<string, unknown> = {};
  for (const flag of ENFORCED) hostile[flag] = false;
  const parsed = validateConfig(hostile) as unknown as Record<string, unknown>;
  for (const flag of ENFORCED) {
    check(`validateConfig forces ${flag} true against false`, parsed[flag] === true);
  }
  const resolved = mergeConfig(validateConfig(hostile)) as unknown as Record<string, unknown>;
  for (const flag of ENFORCED) {
    check(`mergeConfig keeps ${flag} true`, resolved[flag] === true);
  }
}

{
  // ── mixed config: calibrations pass through, hostile flags don't, garbage drops ──
  const resolved = mergeConfig(validateConfig({
    enableSkillState: false,
    enableRootStateFences: false,
    rootContextKeepTurns: 1,
    rootContextElideChars: 900,
    bogusFlag: false,
  })) as unknown as Record<string, unknown>;
  check("calibration keepTurns honored (rlm.json tunes calibrations)", resolved.rootContextKeepTurns === 1);
  check("calibration elideChars honored", resolved.rootContextElideChars === 900);
  check("unknown key dropped by the validator", resolved.bogusFlag === undefined);
  check("hostile enableSkillState cannot survive the merge", resolved.enableSkillState === true);
  check("hostile enableRootStateFences cannot survive the merge", resolved.enableRootStateFences === true);
}

{
  // ── hostile garbage types: fail-soft — a string/array/null where a boolean belongs ──
  const hostile: Record<string, unknown> = {
    enableRunState: "no", enableSkillState: ["off"], enableSkillStateDistill: null,
    enableRootContextTransform: 0, enableRootStateFences: "false", enableRootDigestCompaction: false,
  };
  const resolved = mergeConfig(validateConfig(hostile)) as unknown as Record<string, unknown>;
  for (const flag of ENFORCED) {
    check(`garbage-typed ${flag} still resolves true`, resolved[flag] === true);
  }
}

{
  // ── UI: no toggle path — applySetting has no case for the enforced ids (passthrough) ──
  let cfg = mergeConfig({});
  for (const flag of ENFORCED) {
    cfg = applySetting(cfg, flag, "off");
    cfg = applySetting(cfg, flag, "on");
  }
  const afterPanel = cfg as unknown as Record<string, unknown>;
  for (const flag of ENFORCED) {
    check(`config panel cannot flip ${flag}`, afterPanel[flag] === true);
  }
}

{
  // ── visibility, not silence: explicit `false` emits skillstate.override-ignored ──
  trace("probe.baseline", { note: "trace channel alive" });
  validateConfig({ enableSkillState: false, enableRootStateFences: false });
  const lines = readFileSync(TRACE_FILE, "utf8").trim().split("\n");
  const events = lines.map((line) => JSON.parse(line) as { kind?: string; flag?: string });
  const overrides = events.filter((e) => e.kind === "skillstate.override-ignored");
  check("override-ignored fired for both hostile flags", overrides.length >= 2, String(overrides.length));
  const flagged = new Set(overrides.map((e) => e.flag));
  check("override trace names enableSkillState", flagged.has("enableSkillState"));
  check("override trace names enableRootStateFences", flagged.has("enableRootStateFences"));
}

try {
  rmSync(TRACE_FILE, { force: true });
} catch {
  // fail-soft: a leftover temp trace file must never fail the suite
}

finish();
