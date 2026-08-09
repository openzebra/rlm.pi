/**
 * Subagent-child bypass + native-trade capability tests.
 * Run: bun run pi-plugin/rlm/test/subagent-bypass.ts
 *
 * Process-boundary children (pi subagent example / third-party packages) use native
 * file tools. RLM must not confiscate read/grep without an active `repl` substitute.
 *
 * Layer A: PI_SUBAGENT_CHILD=1 full-bypasses (unless force-in under depth cap).
 * Layer B: even when RLM loads, tool_call blocks only when repl is active.
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

// ── Case B: parent keeps full RLM + blocks when repl active ──

setEnv({});
const B = fakePi(PARENT_ACTIVE_TOOLS);
rlmExtension(B.pi);
for (const h of ["session_start", "turn_end", "before_agent_start", "context", "tool_call", "tool_result", "session_shutdown"]) {
  check(`parent: '${h}' hook registered`, B.tracked.on.includes(h));
}
check("parent: 'rlm' tool registered", B.tracked.registerTool.includes("rlm"));
check("parent: '--rlm' flag registered", B.tracked.registerFlag.includes("rlm"));
check("parent: message renderers registered", B.tracked.registerMessageRenderer.length >= 3);

const tcB = B.tracked.handlers["tool_call"];
const blockB = async (toolName: string, input: Record<string, unknown> = {}) => {
  const result = await tcB({ toolName, input });
  return typeof result === "object" && result !== null && (result as { block?: boolean }).block === true;
};
check("parent: tool_call BLOCKS 'read'", await blockB("read"));
check("parent: tool_call BLOCKS 'grep'", await blockB("grep"));
check("parent: tool_call does NOT block 'edit'", !(await blockB("edit")));
check("parent: tool_call BLOCKS bash reader 'cat'", await blockB("bash", { command: "cat /etc/hostname" }));
check("parent: tool_call does NOT block 'bash ls' (capped, not blocked)", !(await blockB("bash", { command: "ls -la" })));

// ── Case C: force opt-in reactivates RLM in a child ──

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1" });
const C = fakePi(PARENT_ACTIVE_TOOLS);
rlmExtension(C.pi);
check("forced child: 'tool_call' hook registered (RLM active)", C.tracked.on.includes("tool_call"));
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
const tcE = E.tracked.handlers["tool_call"];
const blockE = async (toolName: string, input: Record<string, unknown> = {}) => {
  const result = await tcE({ toolName, input });
  return typeof result === "object" && result !== null && (result as { block?: boolean }).block === true;
};
check("no-repl: tool_call does NOT block 'read'", !(await blockE("read")));
check("no-repl: tool_call does NOT block 'grep'", !(await blockE("grep")));
check("no-repl: tool_call does NOT block bash cat", !(await blockE("bash", { command: "cat foo.ts" })));

// Clean env so later suites in the same process are not polluted when run under smoke.
setEnv({});

const failed = failureCount();
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
