/**
 * tree-panel — the ONE wiring point between pi's UI and the RLM tree.
 *
 * Installs the persistent below-editor widget and mediates keyboard focus:
 * the widget never grabs keys on its own; this panel intercepts Ctrl+R via
 * onTerminalInput, forwards keys while focused, and opens the agent modal on
 * enter. Everything else (tree building, formatting, timelines) is delegated.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TreeWidget } from "../tree/tree-widget.ts";
import { openAgentModal } from "../modal/agent-modal.ts";
import type { RunRegistry } from "./run-registry.ts";

const KEY_CTRL_R = "\x12";
const WIDGET_KEY = "rlm-tree";

export function installTreePanel(ctx: ExtensionContext, registry: RunRegistry): void {
  if (ctx.mode !== "tui") return;

  let widget: TreeWidget | undefined;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      widget?.dispose();
      widget = new TreeWidget(tui, theme, registry);
      return widget;
    },
    { placement: "belowEditor" },
  );

  ctx.ui.onTerminalInput((data) => {
    const current = widget;
    if (current === undefined) return undefined;
    if (!current.isFocused) {
      if (data === KEY_CTRL_R && registry.hasActive()) {
        current.setFocused(true);
        return { consume: true };
      }
      return undefined;
    }
    const action = current.handleKey(data);
    if (action.type === "open") void openAgentModal(ctx, registry, action.runId, action.nodeId);
    return { consume: true };
  });
}
