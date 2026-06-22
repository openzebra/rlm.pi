/**
 * `/rlm` — run a Recursive Language Model over a (possibly huge) context.
 *
 * Usage:
 *   /rlm <question>                       run with no preloaded context
 *   /rlm --file a.txt --file b.txt <q>    load files as a list[str] context
 *   /rlm --paste <question>               open an editor to paste a large context
 *
 * Streams a live agent tree above the editor while the engine runs, then posts the answer.
 * `/rlm-stop` aborts an in-flight run.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { clearRlmStatus, setRlmStatus } from "../ui/status.ts";
import { createTreeWidget } from "../ui/tree-widget.ts";

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
        return await readFile(resolve(ctx.cwd, f), "utf8");
      } catch (e) {
        throw new Error(`could not read --file ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return contents.length === 1 ? contents[0] : contents;
}

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Run a Recursive Language Model over a (possibly huge) context.",
    handler: async (args, ctx) => {
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

      let handle;
      try {
        handle = controller.start(ctx, question, context);
      } catch (e) {
        ctx.ui.notify(`RLM failed to start: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }

      ctx.ui.setWidget("rlm-tree", createTreeWidget(handle.tree), { placement: "aboveEditor" });
      const statusTimer = setInterval(() => setRlmStatus(ctx.ui, handle.tree, "running"), 300);

      try {
        const res = await handle.done;
        pi.sendMessage(
          { customType: "rlm-answer", content: res.answer, display: true, details: { iterations: res.iterations, costUsd: res.costUsd } },
          { triggerTurn: false },
        );
      } catch (e) {
        ctx.ui.notify(`RLM error: ${e instanceof Error ? e.message : e}`, "error");
      } finally {
        clearInterval(statusTimer);
        ctx.ui.setWidget("rlm-tree", undefined);
        clearRlmStatus(ctx.ui);
      }
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
}
