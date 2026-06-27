/**
 * RLM tool — registers the RLM engine as a Pi tool with inline rendering.
 *
 * Modeled after rpiv-mono's subagent tool.
 * The tool's execute() wraps createEngine() with an RlmEmitter + RlmEventAggregator that feeds
 * onUpdate(partialResult) for progressive TUI re-rendering.
 */

import { getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createPiInteractiveDeps } from "../bridge/pi-interactive.ts";
import type { RlmController, StartInput } from "../mode/rlm-mode.ts";
import { createTelemetrySink } from "../telemetry/index.ts";
import { formatCost, formatTokens, spinnerFrame } from "../ui/theme.ts";
import { errorMessage } from "../util/errors.ts";
import { type RlmDetails } from "./rlm-details.ts";
import { RlmEmitter } from "./rlm-events.ts";
import { RlmEventAggregator } from "./rlm-aggregator.ts";
import {
  headlineStatusGlyph,
  renderCollapsedSubcallTree,
  renderExpandedSubcallTree,
} from "./subcall-render.ts";
import { createProgressNotifier, validateToolParams } from "./tool-utils.ts";
import { reviewAndApplyEdits } from "../patch/index.ts";

// ── Parameter schema ──

export const RlmToolParams = Object.freeze(Type.Object({
  prompt: Type.String({ description: "The task or question for the RLM engine" }),
  context: Type.Optional(Type.String({ description: "Optional context. If omitted, repo is auto-packed via repomix." })),
}));

// ── Rendering helpers ──

function rootStats(details: RlmDetails, theme: Theme): string {
  const parts: string[] = [];
  parts.push(formatCost(details.totals.costUsd));
  parts.push(`${formatTokens(details.totals.tokens)} tok`);
  if (details.turns.current > 0) parts.push(`${details.turns.current} turn${details.turns.current > 1 ? "s" : ""}`);
  return theme.fg("dim", parts.join(" · "));
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

      const sink = await createTelemetrySink(controller.config.telemetry);
      const emitter = new RlmEmitter();
      const aggregator = new RlmEventAggregator(emitter, onUpdate ?? (() => {}));
      let detachSink: (() => void) | undefined;
      if (sink) detachSink = emitter.attachSink(sink);
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
          kind: "fresh",
          rootPrompt: params.prompt,
          context: params.context ?? undefined,
        };
        const interactive = createPiInteractiveDeps(ctx);
        const { done } = controller.start(ctx, input, emitter, {
          onAskUserQuestion: controller.config.askUserQuestion ? interactive.onAskUserQuestion : undefined,
          onTodo: controller.config.todo ? interactive.onTodo : undefined,
        });
        const result = await done;

        emitter.emitAnswer(result.answer);
        const proposedEdits = result.edits ?? [];
        const proposedDiffs = result.diffs ?? [];
        if (proposedEdits.length > 0) emitter.emitEdits(proposedEdits);
        await reviewAndApplyEdits(proposedEdits, proposedDiffs, controller.config, ctx);

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
        detachSink?.();
        aggregator.dispose();
        emitter.shutdown();
        try { await sink?.shutdown(); }
        catch (err) { console.warn(`[rlm] telemetry shutdown failed: ${errorMessage(err)}`); }
      }
    },

    renderCall(args, theme, _context) {
      const preview = args.prompt.length > 80
        ? `${args.prompt.slice(0, 80)}...`
        : args.prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("rlm ")) +
        theme.fg("dim", preview.replace(/\n/g, " ")),
        0, 0,
      );
    },

    renderResult(result, { expanded, isPartial: _isPartial }, theme, _context) {
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

  const glyph = headlineStatusGlyph(details.status, theme);
  const header = `${glyph} ${theme.fg("toolTitle", theme.bold("RLM"))} · ${rootStats(details, theme)}`;
  container.addChild(new Text(header, 0, 0));

  if (details.subcalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));
    container.addChild(renderExpandedSubcallTree(details.subcalls, theme));
  }

  if (details.answer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
    container.addChild(new Markdown(details.answer, 0, 0, getMarkdownTheme()));
  }

  if (details.edits && details.edits.length > 0) {
    container.addChild(new Spacer(1));
    const editFiles = new Set(details.edits.map(e => e.path));
    container.addChild(new Text(
      theme.fg("muted", "─── Edits ───") +
      `\n  ${theme.fg("dim", `${details.edits.length} edit${details.edits.length > 1 ? "s" : ""} proposed across ${editFiles.size} file${editFiles.size > 1 ? "s" : ""}`)}`,
      0, 0,
    ));
  }

  return container;
}

// ── Collapsed view ──

function renderCollapsed(details: RlmDetails, theme: Theme): Text {
  const glyph = headlineStatusGlyph(details.status, theme);
  const header = `${glyph} ${theme.fg("toolTitle", theme.bold("RLM"))} · ${rootStats(details, theme)}`;

  let body = "";
  if (details.subcalls.length > 0) {
    body = `\n${renderCollapsedSubcallTree(details.subcalls, theme)}`;
  }

  const expandHint = details.status === "running" ? "" : `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(`${header}${body}${expandHint}`, 0, 0);
}
