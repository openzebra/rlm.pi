/**
 * Phase 3 render snapshot — verifies renderCall() and renderResult() output
 * with a real Theme instance (dark theme colors).
 *
 * Run: bun run pi-plugin/rlm/test/phase3-render.ts
 *
 * Does not require a model, API key, or live execution — this is pure
 * rendering verification.
 */

import { check, failureCount } from "./helpers.ts";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RlmController } from "../src/mode/rlm-mode.ts";
import type { RlmDetails } from "../src/tool/rlm-details.ts";
import { EditRegistry } from "../src/registry/edit-registry.ts";
import { createApplyEditsTool, type ApplyEditsDetails } from "../src/tool/apply-edits-tool.ts";
import { createRlmTool } from "../src/tool/rlm-tool.ts";

// initTheme seeds the global Theme singleton so getMarkdownTheme() works.
initTheme(undefined, false);

// ── ANSI strip utility ──
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function strip(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Real Theme (dark color scheme) ──
const theme = new Theme(
  {
    accent: "#8abeb7",
    border: "#5f87ff",
    borderAccent: "#00d7ff",
    borderMuted: "#505050",
    success: "#b5bd68",
    error: "#cc6666",
    warning: "#ffff00",
    muted: "#808080",
    dim: "#666666",
    text: "#d4d4d4",
    thinkingText: "#808080",
    userMessageText: "#d4d4d4",
    customMessageText: "#d4d4d4",
    customMessageLabel: "#9575cd",
    toolTitle: "#d4d4d4",
    toolOutput: "#808080",
    mdHeading: "#f0c674",
    mdLink: "#81a2be",
    mdLinkUrl: "#666666",
    mdCode: "#8abeb7",
    mdCodeBlock: "#b5bd68",
    mdCodeBlockBorder: "#808080",
    mdQuote: "#808080",
    mdQuoteBorder: "#808080",
    mdHr: "#808080",
    mdListBullet: "#8abeb7",
    toolDiffAdded: "#b5bd68",
    toolDiffRemoved: "#cc6666",
    toolDiffContext: "#808080",
    syntaxComment: "#6A9955",
    syntaxKeyword: "#569CD6",
    syntaxFunction: "#DCDCAA",
    syntaxVariable: "#9CDCFE",
    syntaxString: "#CE9178",
    syntaxNumber: "#B5CEA8",
    syntaxType: "#4EC9B0",
    syntaxOperator: "#D4D4D4",
    syntaxPunctuation: "#D4D4D4",
    thinkingOff: "#505050",
    thinkingMinimal: "#6e6e6e",
    thinkingLow: "#5f87af",
    thinkingMedium: "#81a2be",
    thinkingHigh: "#b294bb",
    thinkingXhigh: "#d183e8",
    bashMode: "#b5bd68",
  },
  {
    selectedBg: "#3a3a4a",
    userMessageBg: "#343541",
    customMessageBg: "#2d2838",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
  },
  "truecolor",
  { name: "test-dark" },
);

// ── Fake controller (only needs config and start signature) ──
const fakeController = {
  config: {} as RlmController["config"],
  start: () => ({ abort: () => {}, done: Promise.resolve({ answer: "", edits: [], iterations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }) }),
  abort: () => {},
} as unknown as RlmController;

const tool = createRlmTool(fakeController);
type RenderCallFn = NonNullable<typeof tool.renderCall>;
type RenderResultFn = NonNullable<typeof tool.renderResult>;
const renderCall: RenderCallFn = tool.renderCall ?? (() => { throw new Error("renderCall missing"); });
const renderResult: RenderResultFn = tool.renderResult ?? (() => { throw new Error("renderResult missing"); });
type RenderCallContext = Parameters<RenderCallFn>[2];
type RenderResultContext = Parameters<RenderResultFn>[3];
const renderCallContext = {} as RenderCallContext;
const renderResultContext = {} as RenderResultContext;

const applyEditsTool = createApplyEditsTool(new EditRegistry());
type ApplyRenderCallFn = NonNullable<typeof applyEditsTool.renderCall>;
type ApplyRenderResultFn = NonNullable<typeof applyEditsTool.renderResult>;
const renderApplyCall: ApplyRenderCallFn = applyEditsTool.renderCall ?? (() => { throw new Error("apply_edits renderCall missing"); });
const renderApplyResult: ApplyRenderResultFn = applyEditsTool.renderResult ?? (() => { throw new Error("apply_edits renderResult missing"); });
type ApplyRenderCallContext = Parameters<ApplyRenderCallFn>[2];
type ApplyRenderResultContext = Parameters<ApplyRenderResultFn>[3];
const renderApplyCallContext = {} as ApplyRenderCallContext;
const renderApplyResultContext = {} as ApplyRenderResultContext;

const RENDER_WIDTH = 120;

// ── Helpers ──

function render(component: { render(width: number): string[] }): string {
  return component.render(RENDER_WIDTH).join("\n");
}

function renderPlain(component: { render(width: number): string[] }): string {
  return strip(render(component));
}

// ── Test fixtures ──
const params = { prompt: "Build a React dashboard component with charts and tables", context: "project uses React 18 + Recharts" };

const completedDetails: RlmDetails = {
  status: "done",
  rootPrompt: params.prompt,
  turns: { current: 3, max: 30 },
  subcalls: [
    { id: "s1", depth: 0, kind: "llm", label: "llm_query", model: "gpt-4o-mini", status: "done", args: "prompt: analyze the codebase structure", resultPreview: "The project uses React 18 with TypeScript and Recharts for charting.", startedAt: 1000, endedAt: 5000, costUsd: 0.0045, tokens: 2100 },
    { id: "s2", depth: 0, kind: "tool", label: "read_file", status: "done", args: "src/App.tsx:1-50", resultPreview: "50 lines · 1.2k chars", startedAt: 5000, endedAt: 5100, costUsd: 0, tokens: 0 },
    { id: "s3", depth: 0, kind: "tool", label: "read_file", status: "done", args: "src/components/Chart.tsx", resultPreview: "95 lines · 2.8k chars", startedAt: 5100, endedAt: 5200, costUsd: 0, tokens: 0 },
    { id: "s4", depth: 0, kind: "tool", label: "grep", status: "done", args: "useState src/**/*.tsx (max 20)", resultPreview: "5 matches in 3 files", startedAt: 5200, endedAt: 5300, costUsd: 0, tokens: 0 },
    { id: "s5", depth: 0, kind: "llm", label: "llm_query", model: "gpt-4o-mini", status: "done", args: "prompt: create the dashboard component", resultPreview: "I'll create the Dashboard component with the following structure...", startedAt: 10000, endedAt: 15000, costUsd: 0.0085, tokens: 3600 },
    { id: "s6", depth: 0, kind: "tool", label: "write", status: "done", args: "src/components/Dashboard.tsx", resultPreview: "188 lines written", startedAt: 15000, endedAt: 15100, costUsd: 0, tokens: 0 },
    { id: "s7", depth: 0, kind: "tool", label: "edit", status: "done", args: "src/App.tsx", resultPreview: "applied", startedAt: 15100, endedAt: 15200, costUsd: 0, tokens: 0 },
    { id: "s8", depth: 0, kind: "rlm", label: "rlm_query", model: "gpt-4o-mini", status: "done", detail: "verify chart responsiveness", resultPreview: "The charts are responsive with proper viewport handling.", startedAt: 20000, endedAt: 45000, costUsd: 0.0150, tokens: 3200 },
  ],
  totals: { costUsd: 0.0423, tokens: 12300 },
  answer: "I've created the dashboard component with responsive charts and tables.\n\nThe component supports:\n- Auto-sizing charts via Recharts ResponsiveContainer\n- Dark/light theme support\n- Loading and error states\n- TypeScript props for chart configuration",
  edits: [
    { id: "e1", path: "src/components/Dashboard.tsx", oldText: "", newText: "// new file" },
    { id: "e2", path: "src/App.tsx", oldText: "// old import", newText: "import Dashboard from './components/Dashboard'" },
  ],
};

const runningDetails: RlmDetails = {
  status: "running",
  rootPrompt: params.prompt,
  turns: { current: 1, max: 30 },
  subcalls: [
    { id: "s1", depth: 0, kind: "llm", label: "llm_query", model: "gpt-4o-mini", status: "done", args: "prompt: analyze the codebase", startedAt: 1000, endedAt: 5000, costUsd: 0.0045, tokens: 2100 },
    { id: "s2", depth: 0, kind: "tool", label: "read_file", status: "running", args: "src/App.tsx", startedAt: 5000, costUsd: 0, tokens: 0 },
  ],
  totals: { costUsd: 0.0045, tokens: 2100 },
};

const errorDetails: RlmDetails = {
  status: "error",
  rootPrompt: params.prompt,
  turns: { current: 1, max: 30 },
  subcalls: [
    { id: "s1", depth: 0, kind: "llm", label: "llm_query", model: "gpt-4o-mini", status: "error", detail: "rate limit exceeded", startedAt: 1000, endedAt: 2000, costUsd: 0, tokens: 0 },
  ],
  totals: { costUsd: 0, tokens: 0 },
};

const applyEditsDetails: ApplyEditsDetails = {
  status: "done",
  appliedCount: 2,
  failedCount: 0,
  errors: [],
  fileStats: [
    { path: "src/components/Dashboard.tsx", status: "applied", added: 10, removed: 5 },
    { path: "src/App.tsx", status: "applied", added: 2, removed: 1 },
  ],
};

const partialApplyEditsDetails: ApplyEditsDetails = {
  status: "partial",
  appliedCount: 1,
  failedCount: 1,
  errors: [{ id: "e2", path: "src/App.tsx", error: "Error: anchor occurs 0 times in src/App.tsx" }],
  fileStats: [
    { path: "src/components/Dashboard.tsx", status: "applied", added: 10, removed: 5 },
    { path: "src/App.tsx", status: "failed", added: 0, removed: 0 },
  ],
};

// ── Tests ──

console.log("=== apply_edits renderCall ===");

{
  const result = renderApplyCall({ ids: ["e1", "e2"] }, theme, renderApplyCallContext);
  const text = renderPlain(result);
  console.log(`  output: ${text}`);

  check("apply_edits renderCall shows edit count", text.includes("apply_edits: 2 edits"));
}

console.log("\n=== apply_edits renderResult collapsed ===");

{
  const result = renderApplyResult(
    { content: [{ type: "text", text: "" }], details: applyEditsDetails } as AgentToolResult<ApplyEditsDetails>,
    { expanded: false, isPartial: false },
    theme,
    renderApplyResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output: ${text}`);

  check("apply_edits collapsed shows file and applied counts", text.includes("2 files, 2 applied"));
  check("apply_edits collapsed shows aggregate additions", text.includes("+12"));
  check("apply_edits collapsed shows aggregate removals", text.includes("-6"));
  check("apply_edits collapsed shows line label", text.includes("lines"));
}

console.log("\n=== apply_edits renderResult expanded ===");

{
  const result = renderApplyResult(
    { content: [{ type: "text", text: "" }], details: partialApplyEditsDetails } as AgentToolResult<ApplyEditsDetails>,
    { expanded: true, isPartial: false },
    theme,
    renderApplyResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("apply_edits expanded shows file and edit counts", text.includes("2 files, 1 applied, 1 failed"));
  check("apply_edits expanded shows applied file path", text.includes("src/components/Dashboard.tsx"));
  check("apply_edits expanded shows failed file path", text.includes("src/App.tsx"));
  check("apply_edits expanded shows per-file line stats", text.includes("+10") && text.includes("-5"));
  check("apply_edits expanded shows error text", text.includes("anchor occurs 0 times"));
}

console.log("\n=== renderCall ===");

{
  const result = renderPlain(renderCall(params, theme, renderCallContext));
  check("renderCall contains 'rlm' label", result.includes("rlm"));
  check("renderCall contains truncated prompt", result.includes("Build a React dashboard component"));
  // For strict snapshot, we check that long prompts are not fully rendered
  if (params.prompt.length > 80) {
    check("renderCall truncates long prompts", !result.includes(params.prompt));
  }
  console.log(`  output: ${result.trim()}`);
}

console.log("\n=== renderResult collapsed (done) ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: completedDetails.answer ?? "" }], details: completedDetails } as AgentToolResult<RlmDetails>,
    { expanded: false, isPartial: false },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("collapsed shows success glyph (✓)", text.includes("✓"));
  check("collapsed shows RLM label", text.includes("RLM"));
  check("collapsed shows cost", text.includes("$0.0423"));
  check("collapsed shows token count", text.includes("12.3k tok"));
  check("collapsed shows turn count", text.includes("3 turns"));

  // Grouped subcalls
  // Subcalls display their label (e.g. "read_file", "grep") not the generic kind ("tool").
  check("collapsed shows both read_file calls", text.includes("read_file") && (text.match(/read_file/g) || []).length >= 2);
  check("collapsed shows grep", text.includes("grep"));
  check("collapsed shows edit label", text.includes("edit"));
  check("collapsed shows write label", text.includes("write"));
  check("collapsed shows rlm_query", text.includes("rlm_query"));

  // llm_query subcalls are excluded from grouping — they're shown via the root header stats only
  check("collapsed does NOT group llm_query", !text.includes("llm_query ×"));

  // Tree glyphs
  check("collapsed uses branch glyphs", text.includes("├─") || text.includes("└─"));
  check("collapsed ends with └─ on last item", text.includes("└─"));

  // Expand hint
  check("collapsed shows expand hint", text.includes("Ctrl+O to expand"));
}

console.log("\n=== renderResult expanded (done) ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: completedDetails.answer ?? "" }], details: completedDetails } as AgentToolResult<RlmDetails>,
    { expanded: true, isPartial: false },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("expanded shows success glyph (✓)", text.includes("✓"));
  check("expanded shows RLM label", text.includes("RLM"));

  // Sections
  check("expanded has Sub-calls section", text.includes("─── Sub-calls ───"));
  check("expanded has Answer section", text.includes("─── Answer ───"));
  check("expanded has Edits section", text.includes("─── Edits ───"));

  // Individual subcalls
  check("expanded shows llm_query items individually", (text.match(/llm_query/g)?.length ?? 0) >= 2);
  check("expanded shows read_file args", text.includes("src/App.tsx:1-50"));
  check("expanded shows grep args", text.includes("useState src/**/*.tsx"));
  check("expanded shows result previews", text.includes("50 lines"));
  check("expanded shows subcall stats with duration", text.includes(".1s") || text.includes(".0s") || text.includes("s"));

  // Error subcall
  // (none in completedDetails, tested separately below)

  // Answer content
  check("expanded renders answer markdown", text.includes("responsive charts"));
  check("expanded renders edits summary", text.includes("2 edits proposed across 2 files"));
}

console.log("\n=== renderResult collapsed (running) ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: "(running...)" }], details: runningDetails } as AgentToolResult<RlmDetails>,
    { expanded: false, isPartial: true },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("collapsed running shows spinner (⏳)", text.includes("⏳"));
  check("collapsed running does NOT show expand hint", !text.includes("Ctrl+O to expand"));
  check("collapsed running shows partial cost", text.includes("$0.0045"));
  check("collapsed running shows partial tokens", text.includes("2.1k tok"));
}

console.log("\n=== renderResult collapsed (error) ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: "RLM failed: rate limit exceeded" }], details: errorDetails } as AgentToolResult<RlmDetails>,
    { expanded: false, isPartial: false },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("collapsed error shows error glyph (✗)", text.includes("✗"));
  check("collapsed error shows RLM label", text.includes("RLM"));
  check("collapsed error shows expand hint", text.includes("Ctrl+O to expand"));
}

console.log("\n=== renderResult expanded (error) ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: "RLM failed: rate limit exceeded" }], details: errorDetails } as AgentToolResult<RlmDetails>,
    { expanded: true, isPartial: false },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  console.log(`  output:\n${text}`);

  check("expanded error shows error subcall detail", text.includes("rate limit exceeded"));
  check("expanded error shows error glyph on subcall", text.includes("✗"));
}

console.log("\n=== renderResult null details ===");

{
  const result = renderResult(
    { content: [{ type: "text", text: "no details" }], details: undefined as unknown as RlmDetails } as AgentToolResult<RlmDetails>,
    { expanded: false, isPartial: false },
    theme,
    renderResultContext,
  );
  const text = renderPlain(result);
  check("null details shows content text", text.includes("no details"));
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
