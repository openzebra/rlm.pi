/**
 * RLM tool — registers the RLM engine as a Pi tool with inline rendering.
 *
 * The tool's execute() wraps createEngine() with an RlmEmitter + RlmEventAggregator that feeds
 * onUpdate(partialResult) for progressive TUI re-rendering.
 */

import { type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RlmController, StartInput } from "../mode/rlm-mode.ts";
import { spinnerFrame } from "../ui/theme.ts";
import { markdownTheme } from "../ui/theme-adapter.ts";
import { previewText } from "../text/preview.ts";
import { errorMessage } from "../util/errors.ts";
import { type RlmDetails } from "./rlm-details.ts";
import { RlmEmitter } from "./rlm-events.ts";
import { RlmEventAggregator } from "./rlm-aggregator.ts";
import {
  cardHeader,
  cardStatsLine,
  renderCollapsedCard,
  renderExpandedSubcallTree,
} from "./subcall-render.ts";
import { createProgressNotifier, validateToolParams } from "./tool-utils.ts";

/** Chars of the prompt shown on the tool call line. */
const CALL_PREVIEW_CHARS = 80;

// ── Parameter schema ──

export const RlmToolParams = Object.freeze(Type.Object({
  prompt: Type.String({ description: "The task or question for the RLM engine" }),
  context: Type.Optional(Type.String({ description: "Optional context. If omitted, the working directory is packed into context." })),
}));

// ── Rendering helpers ──

function rootStats(details: RlmDetails, theme: Theme): string {
  const turns = details.turns.current;
  return cardStatsLine(details.totals, theme, turns > 0 ? `${turns} turn${turns > 1 ? "s" : ""}` : undefined);
}

// ── Tool definition ──

export function createRlmTool(controller: RlmController): ToolDefinition<typeof RlmToolParams, RlmDetails> {
  return {
    name: "rlm",
    label: "RLM",
    description: "Run the Recursive Language Model engine to answer complex questions with code execution and recursive sub-agent calls.",
    parameters: RlmToolParams,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const validation = validateToolParams(RlmToolParams, rawParams, "RLM", (_errors): RlmDetails => ({
        status: "error",
        rootPrompt: "",
        turns: { current: 0, max: 0 },
        subcalls: [],
        totals: { costUsd: 0, tokens: 0 },
      }));
      if (!validation.ok) return validation.error;
      const params = validation.value;

      const emitter = new RlmEmitter();
      const aggregator = new RlmEventAggregator(emitter, onUpdate ?? (() => {}));
      emitter.emitRootPrompt(params.prompt);

      // Wire abort signal to controller
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      // Animated spinner: cycle through braille frames while running
      const progress = createProgressNotifier<RlmDetails>({
        onUpdate,
        getDetails: () => aggregator.getState(),
        isRunning: (details) => details.status === "running",
        renderText: () => `${spinnerFrame()} RLM running…`,
      });
      progress.start();

      try {
        const input: StartInput = {
          rootPrompt: params.prompt,
          context: params.context ?? undefined,
        };
        const { done } = controller.start(ctx, input, emitter);
        const result = await done;

        emitter.emitAnswer(result.answer);

        return {
          content: [{ type: "text", text: result.answer }],
          details: aggregator.getState(),
        };
      } catch (e) {
        emitter.emitStatus("error");
        const msg = `RLM failed: ${errorMessage(e)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: aggregator.getState(),
        };
      } finally {
        progress.stop();
        aggregator.dispose();
        emitter.shutdown();
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("rlm ")) + theme.fg("dim", previewText(args.prompt, CALL_PREVIEW_CHARS)),
        0, 0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as RlmDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      if (expanded) {
        return renderExpanded(details, theme);
      }
      return renderCollapsed(details, theme);
    },
  };
}

// ── Expanded view ──

function renderExpanded(details: RlmDetails, theme: Theme): Component {
  const container = new Container();
  container.addChild(new Text(cardHeader("RLM", details.status, rootStats(details, theme), theme), 0, 0));

  if (details.subcalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));
    container.addChild(renderExpandedSubcallTree(details.subcalls, theme));
  }

  if (details.answer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
    container.addChild(new Markdown(details.answer, 0, 0, markdownTheme(theme)));
  }

  return container;
}

// ── Collapsed view ──

function renderCollapsed(details: RlmDetails, theme: Theme): Text {
  return renderCollapsedCard("RLM", details.status, rootStats(details, theme), details.subcalls, theme);
}
