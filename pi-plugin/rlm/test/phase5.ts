/**
 * Phase 5 verification — deterministic render of the live agent tree (no tokens, no model).
 * Run: bun run pi-plugin/rlm/test/phase5.ts
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { AgentTree } from "../src/state/agent-tree.ts";
import { treeObserver } from "../src/state/events.ts";
import { renderTree } from "../src/ui/tree-widget.ts";

// Minimal theme stub: identity colors so we can assert on plain text.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures++;
};

function main() {
  const tree = new AgentTree();
  const obs = treeObserver(tree);

  const root = obs.start({ kind: "root", depth: 0, model: "smart", label: "root", detail: "find the code" });
  obs.usage(root, 0.0123, 1200);
  const llm = obs.start({ kind: "llm", depth: 0, parentId: root, model: "worker", label: "llm_query", detail: "summarize chunk" });
  obs.end(llm, { costUsd: 0.0003, tokens: 800 });
  const rlm = obs.start({ kind: "rlm", depth: 1, parentId: root, model: "smart", label: "rlm_query", detail: "sub-problem" });
  const nested = obs.start({ kind: "llm", depth: 1, parentId: rlm, model: "worker", label: "llm_query" });
  obs.end(nested);

  const lines = renderTree(tree, theme, 100);
  const text = lines.join("\n");
  console.log(text);

  check("header shows rolled-up totals", /RLM · \$/.test(lines[0] ?? ""));
  check("root node rendered", text.includes("RLM ▸ root"));
  check("llm_query child rendered", text.includes("llm_query"));
  check("rlm_query child rendered", text.includes("rlm_query"));
  check("tree uses branch glyphs", text.includes("├─") || text.includes("└─"));
  check("nested sub-call indented under rlm_query", /[│ ]\s*[├└]─ .*llm_query/.test(text));
  check("running spinner for active rlm node", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text));
  check("totals reflect 2 running (root + rlm)", tree.totals().running === 2, String(tree.totals().running));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
