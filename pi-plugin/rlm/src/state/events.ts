/**
 * SubcallStart — parameter object carried forward for telemetry compatibility.
 *
 * The SubcallObserver interface, treeObserver(), observerWith(), and NOOP_OBSERVER
 * have been removed. The engine and bridges now call RlmToolBridge directly.
 */

import type { SubcallKind } from "../tool/rlm-details.ts";

export interface SubcallStart {
  readonly kind: SubcallKind;
  readonly depth: number;
  readonly parentId?: string;
  readonly model?: string;
  readonly label: string;
  readonly detail?: string;
  readonly args?: string;
  /** Run ID for the root node — lets MLflow correlate a resumed trace with the original. */
  readonly runId?: string;
  /** True when this is a resumed root node (not a fresh start). */
  readonly resume?: boolean;
}
