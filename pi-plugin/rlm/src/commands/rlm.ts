/** `/rlm` — toggle persistent RLM mode or run a one-shot Recursive Language Model. */

import { readFile, stat as fsStat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { postRlmGuide } from "../ui/intro.ts";
import { clearRlmStatus, setRlmModeStatus } from "../ui/status.ts";
import { createTreeWidget } from "../ui/tree-widget.ts";
import { formatCost, formatTokens } from "../ui/theme.ts";

interface ParsedArgs {
  files: string[];
  paste: boolean;
  question: string;
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const files: string[] = [];
  let paste = false;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--file" && tokens[i + 1]) files.push(tokens[++i]!);
    else if (t === "--paste") paste = true;
    else rest.push(t);
  }
  return { files, paste, question: rest.join(" ") };
}

async function loadContext(ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<unknown> {
  if (parsed.paste) return (await ctx.ui.editor("Paste RLM context", "")) ?? "";
  if (parsed.files.length === 0) return "";
  const contents = await Promise.all(
    parsed.files.map(async (f) => {
      try {
        const resolved = resolve(ctx.cwd, f);
        const rel = relative(ctx.cwd, resolved);
        if (rel.startsWith("..")) throw new Error(`--file ${f} escapes workspace`);
        const st = await fsStat(resolved);
        if (st.size > 10 * 1024 * 1024) throw new Error(`--file ${f} exceeds 10MB limit`);
        return await readFile(resolved, "utf8");
      } catch (e) {
        throw new Error(`could not read --file ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return contents.length === 1 ? contents[0] : contents;
}

export async function executeRlmRun(
  pi: ExtensionAPI,
  controller: RlmController,
  ctx: ExtensionContext,
  question: string,
  context: unknown,
  restoreModeStatus = true,
): Promise<void> {
  let handle;
  try {
    handle = controller.start(ctx, question, context);
  } catch (e) {
    ctx.ui.notify(`RLM failed to start: ${e instanceof Error ? e.message : e}`, "error");
    return;
  }

  const { tree, done } = handle;
  ctx.ui.setWidget("rlm-tree", createTreeWidget(tree), { placement: "aboveEditor" });

  const statusTimer = setInterval(() => {
    if (controller.isBusy()) {
      const t = tree.totals();
      ctx.ui.setStatus("rlm", `● RLM · ${formatCost(t.costUsd)} · ${formatTokens(t.tokens)} tok · ${t.running} active`);
    } else {
      clearInterval(statusTimer);
    }
  }, 300);

  try {
    const result = await done;
    pi.sendMessage({
      customType: "rlm-answer",
      content: result.answer,
      display: true,
      details: { iterations: result.iterations, costUsd: result.costUsd },
    });
  } catch (e) {
    ctx.ui.notify(`RLM failed: ${e instanceof Error ? e.message : e}`, "error");
  } finally {
    clearInterval(statusTimer);
    ctx.ui.setWidget("rlm-tree", undefined);
    if (restoreModeStatus) setRlmModeStatus(ctx.ui, controller);
    else clearRlmStatus(ctx.ui);
  }
}

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Toggle RLM mode, or run a one-shot Recursive Language Model with args.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        const enabled = controller.toggle();
        setRlmModeStatus(ctx.ui, controller);
        ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
        return;
      }

      if (controller.isBusy()) {
        ctx.ui.notify("An RLM run is already in progress (use /rlm-stop to cancel).", "warning");
        return;
      }

      const parsed = parseArgs(args);
      let question = parsed.question;
      if (!question) question = (await ctx.ui.input("RLM question", "What should the RLM answer?")) ?? "";
      if (!question.trim()) {
        ctx.ui.notify("RLM: no question provided", "warning");
        return;
      }

      let context: unknown;
      try {
        context = await loadContext(ctx, parsed);
      } catch (e) {
        ctx.ui.notify(`RLM: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }

      await executeRlmRun(pi, controller, ctx, question, context);
    },
  });

  pi.registerCommand("rlm-stop", {
    description: "Abort the in-progress RLM run.",
    handler: async (_args, ctx) => {
      if (!controller.isBusy()) {
        ctx.ui.notify("No RLM run in progress.", "info");
        return;
      }
      controller.abort();
      ctx.ui.notify("RLM run aborted.", "info");
    },
  });

  pi.registerCommand("rlm-help", {
    description: "Show the RLM startup guide and command cheatsheet.",
    handler: async () => {
      postRlmGuide(pi, controller);
    },
  });

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}
