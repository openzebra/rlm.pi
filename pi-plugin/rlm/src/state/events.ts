/**
 * SubcallStart — parameter object carried forward for telemetry compatibility.
 *
 * The SubcallObserver interface, treeObserver(), observerWith(), and NOOP_OBSERVER
 * have been removed. The engine and bridges now call RlmToolBridge directly.
 */

import type { SubcallKind } from "../tool/rlm-details.ts";

export interface SubcallStart {
  kind: SubcallKind;
  depth: number;
  parentId?: string;
  model?: string;
  label: string;
  detail?: string;
  args?: string;
  /** Run ID for the root node — lets MLflow correlate a resumed trace with the original. */
  runId?: string;
  /** True when this is a resumed root node (not a fresh start). */
  resume?: boolean;
}
