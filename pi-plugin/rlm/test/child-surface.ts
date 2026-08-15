/**
 * Phase 5 (v5 port): role separation — delegation-only child sandboxes.
 * Doctrine (v5 rlm_worker "ONLY these"): children delegate (llm + memory/ledger), they do not
 * explore the repo themselves; retrieval belongs to the root. "legacy" is the one-flip rollback.
 */

import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY, ZERO_USAGE } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import type { ChatMsg, CompleteResult } from "../src/bridge/model.ts";
import type { RlmConfig } from "../src/core/types.ts";

/** Presence probe that works inside the sandbox (globals()/eval are blocked by guards):
 *  direct name references wrapped in try/except NameError, one block per name. */
const PROBE_NAMES: readonly string[] = Object.freeze([
  "search", "grep_context", "outline", "add_context",
  "llm_query", "rlm_query", "map_files", "list_claims", "memory",
]);
const PROBE: string = PROBE_NAMES.map((n) =>
  [
    `try:`,
    `    ${n}`,
    `    print('${n}=1')`,
    `except NameError:`,
    `    print('${n}=0')`,
  ].join("\n"),
).join("\n");

function parseFlags(stdout: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of stdout.matchAll(/(\w+)=([01])/g)) out[m[1] ?? ""] = m[2] === "1";
  return out;
}

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

// ── worker level: the two surfaces ──────────────────────────────────────────────

{
  const sb = await PythonSandbox.spawn({
    depth: 1,
    surface: "child",
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 100_000,
    handlers: {
      llmQuery: async () => "x",
      rlmQuery: async () => "y",
      ledgerClaims: async () => "ledger: no claims",
      memoryOp: async () => "memory disabled",
    },
  });
  try {
    const probe = await sb.exec(PROBE);
    const flags = parseFlags(probe.stdout);
    check("child: retrieval + add_context are absent",
      !flags.search && !flags.grep_context && !flags.outline && !flags.add_context, probe.stdout.trim());
    check("child: delegation + memory/ledger surface intact",
      flags.llm_query && flags.rlm_query && flags.map_files && flags.list_claims && flags.memory, probe.stdout.trim());
  } finally {
    await sb.dispose();
  }
}

{
  const sb = await PythonSandbox.spawn({
    depth: 1,
    surface: "root",
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 100_000,
    handlers: {},
  });
  try {
    const probe = await sb.exec(PROBE);
    const flags = parseFlags(probe.stdout);
    check("root: full surface intact", flags.search && flags.grep_context && flags.outline && flags.add_context, probe.stdout.trim());
  } finally {
    await sb.dispose();
  }
}

{
  // Default spawn (no surface option) is root — backwards compatible.
  const sb = await PythonSandbox.spawn({
    depth: 1,
    execTimeoutS: 30,
    requestTimeoutMs: 10_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 100_000,
    handlers: {},
  });
  try {
    const probe = await sb.exec(PROBE);
    const flags = parseFlags(probe.stdout);
    check("default: omitted surface keeps the full root surface", flags.search, probe.stdout.trim());
  } finally {
    await sb.dispose();
  }
}

// ── engine level: children spawned by a root run get the delegation surface ────

async function engineChildProbe(config: RlmConfig): Promise<{ readonly answer: string; readonly childLine: string; readonly childSys: string; readonly rootSys: string }> {
  const seen: ChatMsg[][] = [];
  let rootCall = 0;
  const script = async (msgs: readonly ChatMsg[]): Promise<CompleteResult> => {
    seen.push([...msgs]);
    const sys = msgs.find((m) => m.role === "system")?.content ?? "";
    const isChild = sys.includes("Recursion depth: 1");
    if (isChild) {
      const user = msgs.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      if (user.includes("child-has-search:")) {
        return {
          text: '```repl\nanswer["content"] = "child-done"\nanswer["ready"] = True\n```',
          usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
        };
      }
      return {
        text: '```repl\ntry:\n    search\n    found = "True"\nexcept NameError:\n    found = "False"\nprint("child-has-search:", found, "child-has-llm:", callable(llm_query))\n```',
        usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
      };
    }
    rootCall++;
    if (rootCall === 1) {
      return {
        text: "```repl\nt = rlm_query('inspect the sandbox tool surface availability')\n```",
        usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
      };
    }
    if (rootCall === 2) {
      return {
        text: '```repl\nr = await_task(t)\nprint("OUT:", r[:400])\n```',
        usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
      };
    }
    return {
      text: '```repl\nanswer["content"] = "probe-finished"\nanswer["ready"] = True\n```',
      usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
    };
  };
  const engine = createEngine({
    model: MOCK_MODEL,
    llmModel: MOCK_MODEL,
    registry: MOCK_REGISTRY,
    config,
    emitter: new RlmEmitter(),
    gates: createSubcallGates(4, 2),
    complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
  });
  const out = await engine({ rootPrompt: "audit delegation behavior across engine runs", context: "ctx", depth: 0 });
  const childLine =
    seen.flatMap((msgs) => msgs.map((m) => m.content))
      .find((c) => c.includes("child-has-search: False") || c.includes("child-has-search: True")) ?? "";
  // C5 (audit): the child's SYSTEM prompt must not teach retrieval it does not have.
  const childSys = seen
    .filter((msgs) => (msgs[0]?.content ?? "").includes("Recursion depth: 1"))
    .map((msgs) => msgs[0]?.content ?? "")
    .join("\n");
  const rootSys = seen
    .filter((msgs) => !(msgs[0]?.content ?? "").includes("Recursion depth: 1"))
    .map((msgs) => msgs[0]?.content ?? "")
    .join("\n");
  return { answer: out.answer, childLine, childSys, rootSys };
}

{
  const { answer, childLine, childSys, rootSys } = await engineChildProbe({ ...DEFAULT_CONFIG, maxIterations: 6 });
  check("engine: delegation default — child ran and root finalized", answer === "probe-finished", answer.slice(0, 50));
  check("engine: child sandbox had NO search (delegation doctrine)",
    childLine.includes("child-has-search: False") && childLine.includes("child-has-llm: True"),
    childLine.slice(0, 80));
  check("C5: child system prompt never teaches search(", !childSys.includes("search("), childSys.slice(0, 60));
  check("C5: child system prompt never teaches grep_context(", !childSys.includes("grep_context("), "");
  check("C5: child prompt states the delegation surface", childSys.includes("No `search`"), "");
  check("C5: child prompt shows the delegation spawn example (slice, not search)",
    childSys.includes("slice your world") || childSys.includes("slice the world you were handed"), "");
  check("C5: ROOT prompt still teaches the retrieval example", rootSys.includes("search("), "");
  check("R3: child ENV_TIPS does not instruct locating via search",
    !childSys.includes("free locate with `search`") && !childSys.includes("locate targets with `search`"));
  check("R3: root ENV_TIPS still names search",
    rootSys.includes("free locate with `search`") || rootSys.includes("locate targets with `search`"));

  // Legacy rollback: full child surface restored by one config flip.
  const legacy = await engineChildProbe({ ...DEFAULT_CONFIG, maxIterations: 6, childSurface: "legacy" });
  check("engine: legacy rollback keeps the run working", legacy.answer === "probe-finished", legacy.answer.slice(0, 50));
  check("engine: legacy child keeps search",
    legacy.childLine.includes("child-has-search: True"), legacy.childLine.slice(0, 80));
  check("C5: legacy child prompt keeps the retrieval doctrine", legacy.childSys.includes("search("), "");
}

finish();
