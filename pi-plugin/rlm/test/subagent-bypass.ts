/**
 * Subagent-child bypass + native-trade capability tests.
 * Run: bun run pi-plugin/rlm/test/subagent-bypass.ts
 *
 * Process-boundary children (pi subagent example / third-party packages) use native
 * file tools. RLM no longer hard-blocks read/grep — soft caps only.
 *
 * Layer A: PI_SUBAGENT_CHILD=1 full-bypasses (unless force-in under depth cap).
 *
 * See mode/subagent.ts and the guard at the top of src/index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, failureCount } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import rlmExtension, {
  isSubagentChildBypass,
  commitSubagentForceActivation,
  shouldEnforceNativeReaderBlock,
  processRlmDepth,
} from "../src/index.ts";

function setEnv(obj: Record<string, string>): void {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_RLM_FORCE_IN_SUBAGENT;
  delete process.env.PI_RLM_DEPTH;
  Object.assign(process.env, obj);
}

const PARENT_ACTIVE_TOOLS = Object.freeze([
  "read", "grep", "bash", "edit", "write", "repl", "rlm",
]);

/** A recording fake pi: tracks hook/tool/flag registrations, no-ops everything else. */
function fakePi(activeTools: readonly string[] = PARENT_ACTIVE_TOOLS) {
  const tracked = {
    on: [] as string[],
    handlers: {} as Record<string, (e: unknown) => unknown>,
    registerTool: [] as string[],
    registerFlag: [] as string[],
    registerMessageRenderer: [] as string[],
  };
  const pi = new Proxy({}, {
    get(_t, prop: string) {
      switch (prop) {
        case "on":
          return (e: string, fn: (event: unknown) => unknown) => {
            tracked.on.push(e);
            tracked.handlers[e] = fn;
          };
        case "registerTool":
          return (t: { readonly name?: string }) => {
            tracked.registerTool.push(t?.name ?? "");
          };
        case "registerFlag":
          return (n: string) => { tracked.registerFlag.push(n); };
        case "registerMessageRenderer":
          return (t: string) => { tracked.registerMessageRenderer.push(t); };
        case "getActiveTools":
          return () => [...activeTools];
        default:
          return () => {};
      }
    },
  });
  return { pi: pi as unknown as ExtensionAPI, tracked };
}

// ── Pure helpers ──

setEnv({ PI_SUBAGENT_CHILD: "1" });
check("env: child (PI_SUBAGENT_CHILD=1) -> bypass true", isSubagentChildBypass() === true);

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1" });
check("env: child + force -> bypass false (opt-in honored)", isSubagentChildBypass() === false);

setEnv({});
check("env: parent (no env) -> bypass false", isSubagentChildBypass() === false);

setEnv({ PI_SUBAGENT_CHILD: "0" });
check("env: PI_SUBAGENT_CHILD='0' -> bypass false", isSubagentChildBypass() === false);

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1", PI_RLM_DEPTH: String(DEFAULT_CONFIG.maxDepth) });
check(
  "env: force at depth==maxDepth -> bypass true (refuse force)",
  isSubagentChildBypass() === true,
);

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1", PI_RLM_DEPTH: String(DEFAULT_CONFIG.maxDepth + 1) });
check(
  "env: force at depth>maxDepth -> bypass true",
  isSubagentChildBypass() === true,
);

setEnv({ PI_RLM_DEPTH: "2" });
check("processRlmDepth: valid int", processRlmDepth() === 2);
setEnv({ PI_RLM_DEPTH: "nope" });
check("processRlmDepth: invalid -> 0", processRlmDepth() === 0);
setEnv({});
check("processRlmDepth: missing -> 0", processRlmDepth() === 0);

check(
  "enforce: enabled + repl active -> true",
  shouldEnforceNativeReaderBlock({ enabled: true, activeToolNames: ["read", "repl"] }) === true,
);
check(
  "enforce: enabled + no repl -> false (fail-open)",
  shouldEnforceNativeReaderBlock({ enabled: true, activeToolNames: ["read", "write"] }) === false,
);
check(
  "enforce: disabled -> false",
  shouldEnforceNativeReaderBlock({ enabled: false, activeToolNames: ["repl"] }) === false,
);
check(
  "enforce: enabled + unknown tools -> false (fail-open)",
  shouldEnforceNativeReaderBlock({ enabled: true, activeToolNames: undefined }) === false,
);

// ── commitSubagentForceActivation mutates env ──

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1", PI_RLM_DEPTH: "0" });
commitSubagentForceActivation();
check("commit: force env scrubbed", process.env.PI_RLM_FORCE_IN_SUBAGENT === undefined);
check("commit: depth bumped to 1", process.env.PI_RLM_DEPTH === "1");

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1", PI_RLM_DEPTH: String(DEFAULT_CONFIG.maxDepth) });
commitSubagentForceActivation();
check("commit: at cap does not scrub force", process.env.PI_RLM_FORCE_IN_SUBAGENT === "1");
check("commit: at cap does not bump depth", process.env.PI_RLM_DEPTH === String(DEFAULT_CONFIG.maxDepth));

// ── Case A: child bypasses entirely ──

setEnv({ PI_SUBAGENT_CHILD: "1" });
const A = fakePi();
rlmExtension(A.pi);
check("child: no hooks registered", A.tracked.on.length === 0);
check("child: no tools registered (repl/rlm absent)", A.tracked.registerTool.length === 0);
check("child: no --rlm flag", A.tracked.registerFlag.length === 0);
check("child: no message renderers", A.tracked.registerMessageRenderer.length === 0);

// ── Case B: parent keeps full RLM; never hard-blocks readers ──

setEnv({});
const B = fakePi(PARENT_ACTIVE_TOOLS);
rlmExtension(B.pi);
for (const h of ["session_start", "turn_end", "before_agent_start", "context", "tool_result", "session_shutdown"]) {
  check(`parent: '${h}' hook registered`, B.tracked.on.includes(h));
}
check("parent: no tool_call hard-block hook", !B.tracked.on.includes("tool_call"));
check("parent: 'rlm' tool registered", B.tracked.registerTool.includes("rlm"));
check("parent: '--rlm' flag registered", B.tracked.registerFlag.includes("rlm"));
check("parent: message renderers registered", B.tracked.registerMessageRenderer.length >= 3);

// ── Case C: force opt-in reactivates RLM in a child ──

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1" });
const C = fakePi(PARENT_ACTIVE_TOOLS);
rlmExtension(C.pi);
check("forced child: RLM hooks registered (no reader ban)", C.tracked.on.includes("tool_result"));
check("forced child: force env scrubbed after activate", process.env.PI_RLM_FORCE_IN_SUBAGENT === undefined);
check("forced child: depth bumped", process.env.PI_RLM_DEPTH === "1");

// ── Case D: force refused at depth cap ──

setEnv({
  PI_SUBAGENT_CHILD: "1",
  PI_RLM_FORCE_IN_SUBAGENT: "1",
  PI_RLM_DEPTH: String(DEFAULT_CONFIG.maxDepth),
});
const D = fakePi();
rlmExtension(D.pi);
check("force at cap: no hooks (full bypass)", D.tracked.on.length === 0);

// ── Case E: capability fail-open — enabled, no active repl ──

setEnv({});
const E = fakePi(["read", "write", "bash"]); // no repl (official subagent --tools style)
rlmExtension(E.pi);
check("no-repl: extension still loads", E.tracked.on.includes("session_start"));

// Clean env so later suites in the same process are not polluted when run under smoke.
setEnv({});

const failed = failureCount();
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
