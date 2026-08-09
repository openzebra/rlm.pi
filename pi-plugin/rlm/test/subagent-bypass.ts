/**
 * Subagent-child bypass tests.
 * Run: bun run pi-plugin/rlm/test/subagent-bypass.ts
 *
 * pi-subagents spawns each child as a standalone pi process (PI_SUBAGENT_CHILD=1)
 * built around native file tools. RLM must NOT activate in a child — it would
 * block read/grep with no working repl substitute (the child allowlist has no
 * repl, and the repo pack may fail in a worktree/temp cwd), leaving the child
 * unable to read anything. See the guard at the top of src/index.ts.
 *
 * This suite drives the real default export with a recording fake pi and asserts:
 *   - a child bypasses entirely (no hooks / tools / flags registered)
 *   - the parent keeps full RLM (hooks wired, read/grep blocked, edit/ls allowed)
 *   - PI_RLM_FORCE_IN_SUBAGENT=1 opts a child back in
 */

import { check, failureCount } from "./helpers.ts";
import rlmExtension, { isSubagentChildBypass } from "../src/index.ts";

function setEnv(obj: Record<string, string>) {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_RLM_FORCE_IN_SUBAGENT;
  Object.assign(process.env, obj);
}

/** A recording fake pi: tracks hook/tool/flag registrations, no-ops everything else. */
function fakePi() {
  const tracked = { on: [] as string[], handlers: {} as Record<string, (e: any) => any>, registerTool: [] as string[], registerFlag: [] as string[], registerMessageRenderer: [] as string[] };
  const pi = new Proxy({}, {
    get(_t, prop: string) {
      switch (prop) {
        case "on": return (e: string, fn: any) => { tracked.on.push(e); tracked.handlers[e] = fn; };
        case "registerTool": return (t: any) => { tracked.registerTool.push(t?.name); };
        case "registerFlag": return (n: string) => { tracked.registerFlag.push(n); };
        case "registerMessageRenderer": return (t: string) => { tracked.registerMessageRenderer.push(t); };
        default: return () => {};
      }
    },
  });
  return { pi, tracked };
}

// ── isSubagentChildBypass() env logic ──

setEnv({ PI_SUBAGENT_CHILD: "1" });
check("env: child (PI_SUBAGENT_CHILD=1) -> bypass true", isSubagentChildBypass() === true);

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1" });
check("env: child + force -> bypass false (opt-in honored)", isSubagentChildBypass() === false);

setEnv({});
check("env: parent (no env) -> bypass false", isSubagentChildBypass() === false);

setEnv({ PI_SUBAGENT_CHILD: "0" });
check("env: PI_SUBAGENT_CHILD='0' -> bypass false", isSubagentChildBypass() === false);

// ── Case A: child bypasses entirely ──

setEnv({ PI_SUBAGENT_CHILD: "1" });
const A = fakePi();
rlmExtension(A.pi);
check("child: no hooks registered", A.tracked.on.length === 0);
check("child: no tools registered (repl/rlm absent)", A.tracked.registerTool.length === 0);
check("child: no --rlm flag", A.tracked.registerFlag.length === 0);
check("child: no message renderers", A.tracked.registerMessageRenderer.length === 0);

// ── Case B: parent keeps full RLM ──

setEnv({});
const B = fakePi();
rlmExtension(B.pi);
for (const h of ["session_start", "turn_end", "before_agent_start", "context", "tool_call", "tool_result", "session_shutdown"]) {
  check(`parent: '${h}' hook registered`, B.tracked.on.includes(h));
}
check("parent: 'rlm' tool registered", B.tracked.registerTool.includes("rlm"));
check("parent: '--rlm' flag registered", B.tracked.registerFlag.includes("rlm"));
check("parent: message renderers registered", B.tracked.registerMessageRenderer.length >= 3);

// tool_call behaviour. enabled defaults to true (mergeConfig({})); invoke synchronously
// so the async settings-load microtask cannot flip it before the read is evaluated.
const tc = B.tracked.handlers["tool_call"];
const block = async (toolName: string, input: Record<string, unknown> = {}) => (await tc({ toolName, input }))?.block === true;
check("parent: tool_call BLOCKS 'read'", await block("read"));
check("parent: tool_call BLOCKS 'grep'", await block("grep"));
check("parent: tool_call does NOT block 'edit'", !(await block("edit")));
check("parent: tool_call BLOCKS bash reader 'cat'", await block("bash", { command: "cat /etc/hostname" }));
check("parent: tool_call does NOT block 'bash ls' (capped, not blocked)", !(await block("bash", { command: "ls -la" })));

// ── Case C: force opt-in reactivates RLM in a child ──

setEnv({ PI_SUBAGENT_CHILD: "1", PI_RLM_FORCE_IN_SUBAGENT: "1" });
const C = fakePi();
rlmExtension(C.pi);
check("forced child: 'tool_call' hook registered (RLM active)", C.tracked.on.includes("tool_call"));

const failed = failureCount();
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
