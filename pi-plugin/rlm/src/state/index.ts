/**
 * Barrel for the RLM run-state module.
 *
 * Re-exports every public symbol so `core/engine.ts` and `mode/rlm-mode.ts`
 * import from one door. Type-only re-exports use `export type`.
 */

export { generateRunId, runsDir, runDir, trailPath, contextPath, snapshotPath } from "./paths.ts";
export type {
  UsageRow,
  RunHeader,
  TurnRow,
  CompactionRow,
  TerminalRow,
  TodoRow,
  PhaseRow,
  Row,
} from "./rows.ts";
export { STATE_SCHEMA_VERSION, isHeader, isTurn, isCompaction, isPhase, isTodo, isTerminal } from "./rows.ts";
export { appendRow, appendTodoRow, pruneRuns, writeContextSidecar } from "./writes.ts";
export { readRows, readHeader, readContextSidecar, listRunIds, resolveRunId } from "./reads.ts";
export { reconstructRlmState } from "./resume.ts";
export type { PhaseRecon, ReconstructResult } from "./resume.ts";
