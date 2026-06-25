/**
 * RLM tool — registers the RLM engine as a Pi tool with inline rendering.
 *
 * Modeled after rpiv-mono's subagent tool.
 * The tool's execute() wraps createEngine() with an RlmToolBridge that feeds
 * onUpdate(partialResult) for progressive TUI re-rendering.
 */

import { getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RlmController, StartInput } from "../mode/rlm-mode.ts";
import { createTelemetrySink } from "../telemetry/index.ts";
import { formatCost, formatDuration, formatTokens, spinnerFrame } from "../ui/theme.ts";
import { RlmToolBridge, type RlmDetails, type RlmSubcall } from "./rlm-details.ts";

// ── Parameter schema ──

export const RlmToolParams = Type.Object({
  prompt: Type.String({ description: "The task or question for the RLM engine" }),
  context: Type.Optional(Type.String({ description: "Optional additional context" })),
});

// ── Rendering helpers ──

function headlineGlyph(status: RlmDetails["status"], theme: Theme): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "error": return theme.fg("error", "✗");
    case "aborted": return theme.fg("warning", "◐");
    default: return theme.fg("warning", spinnerFrame()); // animated braille spinner
  }
}

function subcallGlyph(sc: RlmSubcall, theme: Theme): string {
  if (sc.status === "running") return theme.fg("warning", "⏳");
  if (sc.status === "error") return theme.fg("error", "✗");
  return theme.fg("success", "✓");
}

function subcallStats(sc: RlmSubcall): string {
  const parts: string[] = [];
  if (sc.costUsd > 0) parts.push(formatCost(sc.costUsd));
  if (sc.tokens > 0) parts.push(`${formatTokens(sc.tokens)} tok`);
  if (sc.endedAt && sc.startedAt) parts.push(formatDuration(sc.endedAt - sc.startedAt));
  return parts.join(" · ");
}

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
    description: "Run the Recursive Language Model engine to answer complex questions with code execution, file system tools, and recursive sub-agent calls.",
    parameters: RlmToolParams,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      // TypeBox runtime validation before engine start
      if (!Value.Check(RlmToolParams, rawParams)) {
        const errors = [...Value.Errors(RlmToolParams, rawParams)].map(e => `${e.instancePath}: ${e.message}`).join("; ");
        return {
          content: [{ type: "text", text: `Invalid RLM parameters: ${errors}` }],
          details: { status: "error" as const, rootPrompt: "", turns: { current: 0, max: 0 }, subcalls: [], totals: { costUsd: 0, tokens: 0 } },
        };
      }
      const params = rawParams; // narrowed by Value.Check

      const sink = await createTelemetrySink(controller.config.telemetry);
      const bridge = new RlmToolBridge(onUpdate ?? (() => {}), sink);
      bridge.setRootPrompt(params.prompt);

      // Wire abort signal to controller
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      // Animated spinner: cycle through braille frames while running
      let spinnerHandle: ReturnType<typeof setInterval> | undefined;
      if (onUpdate) {
        spinnerHandle = setInterval(() => {
          const snap = bridge.snapshot();
          if (snap.status !== "running") { clearInterval(spinnerHandle); spinnerHandle = undefined; return; }
          onUpdate({ content: [{ type: "text", text: `${spinnerFrame()} RLM running…` }], details: snap });
        }, 100);
      }

      try {
        const input: StartInput = {
          kind: "fresh",
          rootPrompt: params.prompt,
          context: params.context ?? "",
        };
        const { done } = controller.start(ctx, input, bridge);
        const result = await done;

        bridge.setAnswer(result.answer);
        if (result.edits && result.edits.length > 0) bridge.setEdits(result.edits);

        return {
          content: [{ type: "text", text: result.answer }],
          details: bridge.snapshot(),
        };
      } catch (e) {
        bridge.complete("error");
        const msg = `RLM failed: ${e instanceof Error ? e.message : String(e)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: bridge.snapshot(),
        };
      } finally {
        if (spinnerHandle) clearInterval(spinnerHandle);
        try { await sink?.shutdown(); }
        catch (err) { console.warn(`[rlm] telemetry shutdown failed: ${err instanceof Error ? err.message : String(err)}`); }
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

  const glyph = headlineGlyph(details.status, theme);
  const header = `${glyph} ${theme.fg("toolTitle", theme.bold("RLM"))} · ${rootStats(details, theme)}`;
  container.addChild(new Text(header, 0, 0));

  if (details.subcalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));

    // Build parent→children map for hierarchical rendering
    const children = new Map<string | undefined, RlmSubcall[]>();
    for (const sc of details.subcalls) {
      const list = children.get(sc.parentId) ?? [];
      list.push(sc);
      children.set(sc.parentId, list);
    }
    function renderSubcall(sc: RlmSubcall, indent: number): void {
      const pad = "  ".repeat(indent);
      const sGlyph = subcallGlyph(sc, theme);
      const sKind = theme.fg("muted", sc.label);
      const sModel = sc.model ? theme.fg("dim", ` ${sc.model}`) : "";
      const sStats = sc.endedAt ? `  ${theme.fg("dim", subcallStats(sc))}` : "";
      let line = `${pad}${sGlyph} ${sKind}${sModel}${sStats}`;
      if (sc.args) {
        const ap = sc.args.length > 80 ? `${sc.args.slice(0, 80)}...` : sc.args;
        line += `\n${pad}  ${theme.fg("dim", ap)}`;
      }
      if (sc.status === "error" && sc.detail) {
        line += `\n${pad}  ${theme.fg("error", `✗ ${sc.detail}`)}`;
      } else if (sc.resultPreview) {
        const rp = sc.resultPreview.length > 120 ? `${sc.resultPreview.slice(0, 120)}...` : sc.resultPreview;
        line += `\n${pad}  ${theme.fg("toolOutput", rp)}`;
      }
      container.addChild(new Text(line, 0, 0));
      for (const child of (children.get(sc.id) || [])) renderSubcall(child, indent + 1);
    }
    for (const sc of (children.get(undefined) || [])) renderSubcall(sc, 1);
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

function renderCollapsedTree(
  byParent: ReadonlyMap<string | undefined, readonly RlmSubcall[]>,
  parentId: string | undefined,
  prefix: string,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  const direct = byParent.get(parentId) ?? [];
  for (let i = 0; i < direct.length; i++) {
    const sc = direct[i]; const isLast = i === direct.length - 1;
    const branch = isLast ? "└─" : "├─";
    const gGlyph = sc.status === "error" ? theme.fg("error", "✗")
      : sc.status === "running" ? spinnerFrame() : theme.fg("success", "✓");
    const gStats: string[] = [];
    if (sc.costUsd > 0) gStats.push(formatCost(sc.costUsd));
    if (sc.tokens > 0) gStats.push(`${formatTokens(sc.tokens)} tok`);
    lines.push(`${prefix}${branch} ${sc.label}  ${gGlyph}  ${gStats.join(" · ")}`);
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    lines.push(...renderCollapsedTree(byParent, sc.id, childPrefix, theme));
  }
  return lines;
}

function renderCollapsed(details: RlmDetails, theme: Theme): Text {
  const glyph = headlineGlyph(details.status, theme);
  const header = `${glyph} ${theme.fg("toolTitle", theme.bold("RLM"))} · ${rootStats(details, theme)}`;

  let body = "";
  if (details.subcalls.length > 0) {
    const byParent = new Map<string | undefined, RlmSubcall[]>();
    for (const sc of details.subcalls) {
      const bucket = byParent.get(sc.parentId) ?? [];
      bucket.push(sc);
      byParent.set(sc.parentId, bucket);
    }
    const tree = renderCollapsedTree(byParent, undefined, "  ", theme);
    if (tree.length > 0) body = `\n${tree.join("\n")}`;
  }

  const expandHint = details.status === "running" ? "" : `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(`${header}${body}${expandHint}`, 0, 0);
}
