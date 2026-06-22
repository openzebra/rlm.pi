/** Footer status line for an active RLM run (complements the tree widget above the editor). */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentTree } from "../state/agent-tree.ts";
import { formatCost, formatTokens } from "./theme.ts";

const KEY = "rlm";

export function setRlmStatus(ui: ExtensionUIContext, tree: AgentTree, phase: string): void {
  const t = tree.totals();
  ui.setStatus(KEY, `● RLM ${phase} · ${formatCost(t.costUsd)} · ${formatTokens(t.tokens)} tok · ${t.running} active`);
}

export function clearRlmStatus(ui: ExtensionUIContext): void {
  ui.setStatus(KEY, undefined);
}
