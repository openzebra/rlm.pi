/**
 * SKILL.state Workstream A — applyPatch units: valid patches, null-deletion, nested merge,
 * implicit-drop rejection, type guards, cap eviction, rollback semantics, compact-JSON
 * round-trip. Run: bun run pi-plugin/rlm/test/phase-rs-patch.ts
 */

import {
  applyPatch,
  applyStatePatches,
  compactJSON,
  freshRunState,
  isRunState,
  RUN_STATE_LIMITS,
  type RunStateMode,
} from "../src/core/run-state.ts";
import { findStatePatches } from "../src/text/parsing.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { check, finish } from "./helpers.ts";

function base() {
  return freshRunState("probe the retry policy");
}

// ── valid patches ────────────────────────────────────────────────────────────────
{
  const s0 = base();
  const r = applyPatch(
    s0,
    {
      state_patch: {
        "verifiedFacts[+]": "src/a.ts — entry point",
        "findings[+]": "retry lives in retry.py",
        nextStep: "read retry.py",
      },
    },
    1,
  );
  check("valid patch applies", r.ok);
  if (r.ok) {
    check("fact committed", r.value.verifiedFacts.includes("src/a.ts — entry point"));
    check("finding committed", r.value.findings.includes("retry lives in retry.py"));
    check("nextStep set", r.value.nextStep === "read retry.py");
    check("updatedAt stamped", r.value.updatedAt === 1);
    check("task invariant", r.value.task === s0.task);
  }
}

// ── array ops: [+], [N] set, [N] null delete ─────────────────────────────────────
{
  const r1 = applyPatch(base(), JSON.parse('{"state_patch": {"findings[+]": "a", "findings[+]": "b"}}') as unknown, 1);
  check("[+] appends (later duplicate key wins — JSON object semantics)", r1.ok);
  if (r1.ok) {
    const r2 = applyPatch(r1.value, { state_patch: { "findings[1]": "b2" } }, 2);
    check("[N] sets in place", r2.ok && r2.value.findings.join(",") === "b,b2");
    if (r2.ok) {
      const r3 = applyPatch(r2.value, { state_patch: { "findings[0]": null } }, 3);
      check("[N]: null deletes without holes", r3.ok && r3.value.findings.join(",") === "b2");
      if (r3.ok) {
        const r4 = applyPatch(r3.value, { state_patch: { "findings[9]": "x" } }, 4);
        check("[N] beyond len rejected (no holes)", !r4.ok);
      }
    }
  }
}

// ── dedup by claim key ───────────────────────────────────────────────────────────
{
  const r = applyPatch(
    base(),
    { state_patch: { "findings[+]": "Same Fact", "findings": ["same fact"] } },
    1,
  );
  check("findings dedup case/whitespace-insensitive", r.ok && r.value.findings.length === 1);
}

// ── records: dotted entry write + null delete ────────────────────────────────────
{
  const r = applyPatch(
    base(),
    {
      state_patch: {
        "testedApproaches.h1": { status: "failed", reason: "grep too narrow" },
        "artifacts.trace": "trace_lines",
      },
    },
    1,
  );
  check("dotted record writes", r.ok);
  if (r.ok) {
    check("approach stored", r.value.testedApproaches.h1?.status === "failed");
    check("artifact stored", r.value.artifacts.trace === "trace_lines");
    const r2 = applyPatch(
      r.value,
      // Strict merge: the prev entry's `reason` key must be restated or explicitly nulled.
      { state_patch: { "testedApproaches.h1": { status: "succeeded", evidence: "found it", reason: null } } },
      2,
    );
    check("dotted entry replace (explicit null retires the old key)", r2.ok && r2.value.testedApproaches.h1?.status === "succeeded");
    if (r2.ok) {
      const r3 = applyPatch(r2.value, { state_patch: { "artifacts.trace": null } }, 3);
      check("dotted null deletes", r3.ok && !("trace" in r3.value.artifacts));
    }
  }
}

// ── whole-record strict merge: implicit key drops rejected (§5.7) ────────────────
{
  const s1 = applyPatch(base(), { state_patch: { "testedApproaches.h1": { status: "partial", note: "x" } } }, 1);
  if (s1.ok) {
    const dropped = applyPatch(s1.value, { state_patch: { testedApproaches: { other: { status: "partial", note: "y" } } } }, 2);
    check("implicit key drop rejected", !dropped.ok);
    const explicit = applyPatch(
      s1.value,
      { state_patch: { testedApproaches: { h1: null, other: { status: "partial", note: "y" } } } },
      2,
    );
    check("explicit null delete accepted", explicit.ok && explicit.value.testedApproaches.other !== undefined);
  }
  // nested implicit drop inside one entry
  const nested = applyPatch(
    base(),
    { state_patch: { "testedApproaches.h1": { status: "succeeded", evidence: "e" } } },
    1,
  );
  if (nested.ok) {
    const r = applyPatch(nested.value, { state_patch: { "testedApproaches.h1": { status: "succeeded" } } }, 2);
    check("nested implicit drop rejected (entry lost 'evidence')", !r.ok);
  }
}

// ── type guards / schema rejections ─────────────────────────────────────────────
{
  check("non-patch rejected", !applyPatch(base(), { nope: true }, 1).ok);
  check("empty patch rejected", !applyPatch(base(), { state_patch: {} }, 1).ok);
  check("unknown field rejected", !applyPatch(base(), { state_patch: { bogus: 1 } }, 1).ok);
  check("updatedAt is runtime-stamped", !applyPatch(base(), { state_patch: { updatedAt: 5 } }, 1).ok);
  check("array type coercion rejected", !applyPatch(base(), { state_patch: { findings: "one" } }, 1).ok);
  check("scalar type coercion rejected", !applyPatch(base(), { state_patch: { nextStep: 5 } }, 1).ok);
  check("bad outcome rejected", !applyPatch(base(), { state_patch: { "testedApproaches.h": { status: "meh" } } }, 1).ok);
  check("task cap enforced", !applyPatch(base(), { state_patch: { task: "x".repeat(201) } }, 1).ok);
  check("malformed key rejected", !applyPatch(base(), { state_patch: { "findings!!": "x" } }, 1).ok);
  check("array op on record rejected", !applyPatch(base(), { state_patch: { "testedApproaches[+]": "x" } }, 1).ok);
}

// ── rollback: failed patch never touches prev ───────────────────────────────────
{
  const s0 = base();
  const before = compactJSON(s0);
  applyPatch(s0, { state_patch: { "verifiedFacts[+]": "good", bogus: 1 } }, 1);
  check("rollback: prev unchanged after rejection", compactJSON(s0) === before);
}

// ── cap eviction: arrays, records, bytesTotal cascade ────────────────────────────
{
  const patch: string[] = [];
  for (let i = 0; i < RUN_STATE_LIMITS.findings + 5; i++) patch.push(`"finding number ${i} is here"`);
  const r = applyPatch(base(), { state_patch: { findings: JSON.parse(`[${patch.join(",")}]`) as string[] } }, 1);
  check("findings capped", r.ok && r.value.findings.length === RUN_STATE_LIMITS.findings);
  check("oldest evicted first", r.ok && !r.value.findings.includes("finding number 0 is here"));
  const keys: Record<string, string> = {};
  for (let i = 0; i < RUN_STATE_LIMITS.artifacts + 3; i++) keys[`artifact_${i}`] = `var_${i}`;
  const r2 = applyPatch(base(), { state_patch: { artifacts: keys } }, 1);
  check("artifacts capped", r2.ok && Object.keys(r2.value.artifacts).length === RUN_STATE_LIMITS.artifacts);
  // bytesTotal: flood findings with giant strings until the cascade must evict everything.
  const giant = Array.from({ length: 40 }, (_, i) => `f${i}: ${"x".repeat(2000)}`);
  const r3 = applyPatch(base(), { state_patch: { findings: giant } }, 1);
  check("bytesTotal enforced", r3.ok && JSON.stringify(r3.value).length <= RUN_STATE_LIMITS.bytesTotal);
}

// ── compact JSON round-trip + guard ─────────────────────────────────────────────
{
  const r = applyPatch(base(), { state_patch: { "verifiedFacts[+]": "f", nextStep: "n" } }, 7);
  if (r.ok) {
    const s = JSON.parse(compactJSON(r.value)) as unknown;
    check("compact round-trip", isRunState(s));
    check("compact has no pretty whitespace", !compactJSON(r.value).includes(", "));
  }
}

// ── fence extraction + applyStatePatches + degradation ──────────────────────────
{
  const text = [
    "```repl",
    "print(1)",
    "```",
    "```state",
    '{"state_patch": {"verifiedFacts[+]": "committed fact"}}',
    "```",
    "```state",
    '{"state_patch": {"bogus": 1}}',
    "```",
  ].join("\n");
  const parsed = findStatePatches(text);
  check("two fences found", parsed.length === 2);
  const mode: RunStateMode = { kind: "active", state: base(), retries: 0 };
  const out = applyStatePatches(mode, parsed, 3, DEFAULT_CONFIG);
  check("good fence applied before bad rolled back", out.mode.kind === "active" && out.mode.state.verifiedFacts.includes("committed fact"));
  check("rejection observed", out.observation !== undefined && out.observation.includes("state patch rejected"));
  check("retry counted", out.mode.kind === "active" && out.mode.retries === 1);
  // retries exhausted ⇒ degrade
  const degraded = applyStatePatches(
    { kind: "active", state: base(), retries: DEFAULT_CONFIG.runStateRetryMax },
    findStatePatches("```state\n{\"state_patch\": {\"bogus\": 1}}\n```"),
    4,
    DEFAULT_CONFIG,
  );
  check("retry exhaustion degrades", degraded.mode.kind === "degraded");
  // clean turn: no fences, no observation, mode untouched
  const clean = applyStatePatches(mode, findStatePatches("```repl\nprint(2)\n```"), 5, DEFAULT_CONFIG);
  check("fence-free turn is a no-op", clean.mode === mode && clean.observation === undefined);
}

finish();
