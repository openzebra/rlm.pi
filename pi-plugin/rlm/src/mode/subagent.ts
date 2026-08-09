/**
 * Subagent / process-boundary isolation for RLM.
 *
 * Two layers:
 *   1. Env fast path — packages that set PI_SUBAGENT_CHILD=1 fully bypass RLM.
 *   2. Capability gate — never confiscate native readers unless `repl` is in the
 *      active tool set (paper trade: scaffold only if the REPL substitute exists).
 *
 * In-process rlm_query depth is handled by subcall-handlers.childRun; this module
 * only covers OS-process children (pi subagents), which restart at depth 0.
 */
import { DEFAULT_CONFIG } from "../config/defaults.ts";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const RLM_FORCE_IN_SUBAGENT_ENV = "PI_RLM_FORCE_IN_SUBAGENT";
export const RLM_DEPTH_ENV = "PI_RLM_DEPTH";

/** Cross-process depth from env. Missing / invalid → 0. */
export function processRlmDepth(): number {
  const raw = process.env[RLM_DEPTH_ENV];
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * True when this process should not activate RLM at all (no tools / hooks / flags).
 *
 * - Parent (no PI_SUBAGENT_CHILD=1) → false.
 * - Child without force → true.
 * - Child with force but depth >= maxDepth → true (refuse force; paper §7 cost bound).
 * - Child with force and depth < maxDepth → false (experimental opt-in).
 */
export function isSubagentChildBypass(maxDepth: number = DEFAULT_CONFIG.maxDepth): boolean {
  if (process.env[SUBAGENT_CHILD_ENV] !== "1") return false;
  if (process.env[RLM_FORCE_IN_SUBAGENT_ENV] !== "1") return true;
  return processRlmDepth() >= maxDepth;
}

/**
 * Call only when RLM will activate. Scrubs force so grandchildren that inherit env
 * do not re-open unbounded force; bumps PI_RLM_DEPTH for any re-set force path.
 * No-op when not a forced child under the depth cap.
 */
export function commitSubagentForceActivation(maxDepth: number = DEFAULT_CONFIG.maxDepth): void {
  if (process.env[SUBAGENT_CHILD_ENV] !== "1") return;
  if (process.env[RLM_FORCE_IN_SUBAGENT_ENV] !== "1") return;
  if (processRlmDepth() >= maxDepth) return;
  const next = processRlmDepth() + 1;
  delete process.env[RLM_FORCE_IN_SUBAGENT_ENV];
  process.env[RLM_DEPTH_ENV] = String(next);
}

/**
 * RLM's native-mode trade: confiscate read/grep (and bash readers) only when the
 * substitute is actually callable. Fail-open when the active tool list is unknown
 * or does not include `repl` (official pi subagent uses --tools without repl).
 */
export function shouldEnforceNativeReaderBlock(opts: {
  readonly enabled: boolean;
  readonly activeToolNames: readonly string[] | undefined;
}): boolean {
  if (!opts.enabled) return false;
  const names = opts.activeToolNames;
  if (names === undefined) return false;
  return names.includes("repl");
}
