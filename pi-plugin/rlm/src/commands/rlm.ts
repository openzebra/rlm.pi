/** `/rlm` — toggle persistent Recursive Language Model mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { setRlmModeStatus } from "../ui/status.ts";

/**
 * `stopNative` aborts the native-mode session work (repl cells, child engines, detached
 * spawn() tasks) and reports whether any was in flight. Optional so tests can register the
 * bare command; production wires the closure accessors from src/index.ts.
 */
export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController, stopNative?: () => boolean): void {
  pi.registerCommand("rlm", {
    description: "Toggle persistent RLM mode (route plain prompts through the RLM engine).",
    handler: async (_args, ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx, controller, ctx.getContextUsage());
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("rlm-stop", {
    description: "Abort in-progress RLM work: RLM runs, native repl cells, background tasks.",
    handler: async (_args, ctx) => {
      const rlmBusy = controller.isBusy();
      if (rlmBusy) controller.abort();
      const nativeBusy = stopNative?.() ?? false;
      if (rlmBusy || nativeBusy) {
        ctx.ui.notify("RLM work aborted — runs, repl cells and background tasks stopped.", "info");
      } else {
        ctx.ui.notify("No RLM work in progress.", "info");
      }
    },
  });

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode (off also stops a running query)",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx, controller, ctx.getContextUsage());
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}
