/**
 * Phase 5 verification — deterministic render of the live agent tree (no tokens, no model).
 * Run: bun run pi-plugin/rlm/test/phase5.ts
 */

import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createFsBridge } from "../src/bridge/fs-tools.ts";
import { createLlmBridge } from "../src/bridge/llm-query.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { shouldCompact } from "../src/core/compaction.ts";
import { createEngine } from "../src/core/engine.ts";
import { AgentTree } from "../src/state/agent-tree.ts";
import { treeObserver, type SubcallObserver } from "../src/state/events.ts";
import { renderTree } from "../src/ui/tree-widget.ts";

// Minimal theme stub: identity colors so we can assert on plain text.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures++;
};

function testCompactionFallback(): void {
  check("compaction defaults on", DEFAULT_CONFIG.compaction);
  const huge = "x".repeat(600_000);
  const compact = shouldCompact([{ role: "user", content: huge }], { model: {} as Model<Api>, registry: {} as ModelRegistry, thresholdPct: 0.1 });
  check("compaction uses fallback context window", compact);
}

async function testFsBridgeObserver(): Promise<void> {
  const tree = new AgentTree();
  const obs = treeObserver(tree);
  const root = obs.start({ kind: "root", depth: 0, label: "root" });
  const fs = createFsBridge(process.cwd(), { observer: obs, parentId: root });
  await fs.readFile("pi-plugin/rlm/README.md", 1, 3);
  const text = renderTree(tree, theme, 120).join("\n");
  check("fs bridge emits read_file node", text.includes("read_file"));
  check("fs bridge emits args line", text.includes("pi-plugin/rlm/README.md:1-3"));
  check("fs bridge emits result line", text.includes("→") && text.includes("lines"));
}

async function testStartupFailureEndsNode(): Promise<void> {
  const tree = new AgentTree();
  const model = { id: "smart", provider: "test", cost: { input: 0, output: 0 }, contextWindow: 1000 } as Model<Api>;
  const registry = { find: () => undefined, getAvailable: () => [model] } as unknown as ModelRegistry;
  const engine = createEngine({
    smartModel: model,
    workerModel: model,
    registry,
    config: { ...DEFAULT_CONFIG, python: "definitely-missing-python-for-rlm-test" },
    observer: treeObserver(tree),
  });
  try {
    await engine({ rootPrompt: "x", context: "x", depth: 0 });
    check("startup failure throws", false);
  } catch {
    check("startup failure ends root node", tree.totals().running === 0, String(tree.totals().running));
    check("startup failure marks root error", tree.children(undefined)[0]?.status === "error");
  }
}

async function testBatchedFailure(): Promise<void> {
  let endedError = "";
  let endedResult = "";
  const observer: SubcallObserver = {
    start: () => "batch",
    end: (_id, opts) => { endedError = opts?.error ?? ""; endedResult = opts?.resultPreview ?? ""; },
    usage: () => {},
    detail: () => {},
    action: () => {},
    result: () => {},
  };
  const workerModel = { id: "worker", provider: "test", cost: { input: 0, output: 0 } } as Model<Api>;
  const registry = { find: () => undefined } as unknown as ModelRegistry;
  const bridge = createLlmBridge({ workerModel, registry, observer });
  const out = await bridge.llmQueryBatched(["a", "b"], "missing/model", 0);
  check("batched call returns per-item errors", out.length === 2 && out.every((v) => v.startsWith("Error:")));
  check("batched failure surfaces on tree node", endedError === "all 2 sub-calls failed", endedError);
  check("batched response preview surfaces on tree node", endedResult.includes("(+1 more)"), endedResult);
}

async function main() {
  const tree = new AgentTree();
  const obs = treeObserver(tree);

  const root = obs.start({ kind: "root", depth: 0, model: "smart", label: "root", detail: "find the code" });
  obs.usage(root, 0.0123, 1200);
  const tool = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/jwt.ts:1-120" });
  obs.end(tool, { resultPreview: "118 lines · 3.2k chars" });
  const llm = obs.start({ kind: "llm", depth: 0, parentId: root, model: "worker", label: "llm_query", args: "prompt: summarize chunk" });
  obs.end(llm, { costUsd: 0.0003, tokens: 800, resultPreview: "Worker response summary with exported symbol details" });
  const rlm = obs.start({ kind: "rlm", depth: 1, parentId: root, model: "smart", label: "rlm_query", detail: "sub-problem" });
  obs.action(root, "▶ print('root stdout sample')");
  obs.result(root, "root stdout sample");
  const nested = obs.start({ kind: "llm", depth: 1, parentId: rlm, model: "worker", label: "llm_query" });
  obs.end(nested);

  const lines = renderTree(tree, theme, 100);
  const text = lines.join("\n");
  console.log(text);

  check("header shows rolled-up totals", /RLM · \$/.test(lines[0] ?? ""));
  check("root node rendered", text.includes("root"));
  check("llm_query child rendered", text.includes("llm_query"));
  check("llm_query node carries response preview", tree.get(llm)?.resultPreview === "Worker response summary with exported symbol details");
  check("llm_query response preview rendered", text.includes("Worker response summary"));
  check("root node carries action preview", tree.get(root)?.args === "▶ print('root stdout sample')");
  check("root node carries stdout preview", tree.get(root)?.resultPreview === "root stdout sample");
  check("root action preview rendered", text.includes("▶ print('root stdout sample')"));
  check("root stdout preview rendered", text.includes("→ root stdout sample"));
  check("read_file tool rendered", text.includes("read_file"));
  check("tool args rendered", text.includes("src/auth/jwt.ts:1-120"));
  check("tool result preview rendered", text.includes("→ 118 lines"));
  check("rlm_query child rendered", text.includes("rlm_query"));
  check("tree uses branch glyphs", text.includes("├─") || text.includes("└─"));
  check("nested sub-call indented under rlm_query", /[│ ]\s*[├└]─ .*llm_query/.test(text));
  check("running spinner for active rlm node", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text));
  check("totals reflect 2 running (root + rlm)", tree.totals().running === 2, String(tree.totals().running));

  testCompactionFallback();
  await testFsBridgeObserver();
  await testStartupFailureEndsNode();
  await testBatchedFailure();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
