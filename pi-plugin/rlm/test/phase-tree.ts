/**
 * phase-tree — tree panel data path: emitter → store/aggregator/timeline →
 * registry → pure row model/formatter → modal view. No terminal, no sandbox:
 * every layer below the widget is exercised with the real classes.
 */

import { check, failureCount } from "./helpers.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { SubcallStore } from "../src/tool/subcall-store.ts";
import { RlmEventAggregator } from "../src/tool/rlm-aggregator.ts";
import { RunRegistry } from "../src/ui/panel/run-registry.ts";
import { buildRows, type NodeRow } from "../src/ui/tree/tree-model.ts";
import { formatRows, modelShort } from "../src/ui/tree/tree-rows.ts";
import { buildModalLines, MODAL_LAYOUT } from "../src/ui/modal/modal-view.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Identity theme: assertions match raw text, colors would only add noise.
const theme = { fg: (_color: string, s: string) => s } as unknown as Theme;

// ── events: phase flows through the store ──
{
  const emitter = new RlmEmitter();
  const store = new SubcallStore(emitter);
  const id = emitter.emitSubcallCreated({ kind: "rlm", label: "rlm_query", depth: 1 });
  emitter.emitSubcallUpdated({ id, phase: "thinking" });
  const node = store.getSubcalls().find((sc) => sc.id === id);
  check("store: phase recorded on node", node?.phase === "thinking");
  emitter.emitSubcallUpdated({ id, status: "done" });
  check("store: phase survives status update", store.getSubcalls()[0]?.phase === "thinking");
  store.dispose();
  emitter.shutdown();
}

// ── aggregator: root phase lands in RlmDetails ──
{
  const emitter = new RlmEmitter();
  const agg = new RlmEventAggregator(emitter);
  emitter.emitRootPrompt("study the repo");
  emitter.emitRootPhase("repl");
  check("aggregator: rootPhase in snapshot", agg.getState().rootPhase === "repl");
  check("aggregator: rootPhase defaults undefined", agg.getState().rootPrompt === "study the repo");
  agg.dispose();
  emitter.shutdown();
}

// ── registry: register, snapshots, hideWhenEmpty, unregister ──
{
  const registry = new RunRegistry();
  const emitter = new RlmEmitter();
  const store = new SubcallStore(emitter);
  check("registry: empty is inactive", !registry.hasActive());

  const unregister = registry.register({
    runId: "run1",
    label: "root: analyze repo",
    emitter,
    subcalls: () => store.getSubcalls(),
    totals: () => store.getTotals(),
  });
  check("registry: registered run is active", registry.hasActive());
  check("registry: root phase default undefined", registry.snapshots()[0]?.rootPhase === undefined);

  const bgEmitter = new RlmEmitter("bg");
  const bgStore = new SubcallStore(bgEmitter);
  registry.register({
    runId: "background",
    label: "background",
    emitter: bgEmitter,
    subcalls: () => bgStore.getSubcalls(),
    totals: () => bgStore.getTotals(),
    hideWhenEmpty: true,
  });
  check("registry: hideWhenEmpty stays out of snapshots", registry.snapshots().length === 1);
  bgEmitter.emitSubcallCreated({ kind: "llm", label: "llm_query", depth: 0 });
  check("registry: bg appears once it holds work", registry.snapshots().length === 2);

  unregister();
  check("registry: unregister removes the run", registry.snapshots().length === 1);
  unregister();
  check("registry: unregister is idempotent", registry.snapshots().length === 1);
  store.dispose();
  bgStore.dispose();
  emitter.shutdown();
  bgEmitter.shutdown();
}

// ── tree model: agents first, overflow, collapse, subtree tokens ──
{
  const registry = new RunRegistry();
  const emitter = new RlmEmitter();
  const store = new SubcallStore(emitter);
  // Production registers BEFORE any event fires — mirror that ordering so the
  // timeline store (subscribed at registration) sees everything below.
  registry.register({ runId: "run1", label: "root", emitter, subcalls: () => store.getSubcalls(), totals: () => store.getTotals() });
  const agentId = emitter.emitSubcallCreated({ kind: "rlm", label: "rlm_query: auth", model: "openai/gpt-5", depth: 1 });
  emitter.emitSubcallUpdated({ id: agentId, phase: "waiting", tokens: 100 });
  for (let i = 0; i < 7; i++) {
    const leaf = emitter.emitSubcallCreated({ kind: "llm", label: `llm_query: p${i}`, model: "openai/gpt-5-mini", depth: 1 });
    emitter.emitSubcallUpdated({ id: leaf, status: "done", tokens: 10 });
  }
  const childLeaf = emitter.emitSubcallCreated({ kind: "llm", parentId: agentId, label: "llm_query: inner", model: "m/x", depth: 2 });
  emitter.emitSubcallUpdated({ id: childLeaf, status: "done", tokens: 50 });

  const snapshot = registry.snapshots()[0];
  check("model: snapshot exists", snapshot !== undefined);
  if (snapshot === undefined) throw new Error("snapshot missing");

  const rows = buildRows(snapshot, new Set());
  const nodeRows = rows.filter((r): r is NodeRow => r.type === "node");
  check("model: root row first", nodeRows[0]?.id === "run1");
  check("model: agent sorts before llm leaves", nodeRows[1]?.id === agentId);
  check("model: agent row carries subtree tokens", nodeRows[1]?.tokens === 150);
  check("model: overflow marker caps leaves", rows.some((r) => r.type === "overflow" && r.count === 4));
  check("model: rows carry runId for modal lookup", nodeRows[1]?.runId === "run1");

  const collapsedRows = buildRows(snapshot, new Set([agentId]));
  const collapsedAgent = collapsedRows.find((r): r is NodeRow => r.type === "node" && r.id === agentId);
  check("model: collapsed hides children", collapsedAgent?.expanded === false && !collapsedRows.some((r) => r.type === "node" && r.id === childLeaf));

  // ── row formatting: tokens + short model, never "$" ──
  const lines = formatRows(rows, agentId, 72, theme);
  check("rows: one line per row", lines.length === rows.length);
  check("rows: agent line shows subtree tokens", lines[1]?.includes("150 tok") === true);
  check("rows: model shortened to last segment", lines[1]?.includes("gpt-5") === true);
  check("rows: no cost anywhere", lines.every((l) => !l.includes("$")));
  check("rows: selection cursor rendered", lines[1]?.includes("❯") === true);
  check("rows: modelShort caps length", modelShort("provider/a-very-long-model-name-here").length <= 15);

  // ── modal view: header + timeline, stable height, no "$" ──
  const run = registry.find("run1");
  check("modal: run found", run !== undefined);
  if (run !== undefined) {
    const node = run.subcalls().find((sc) => sc.id === agentId);
    check("modal: node found", node !== undefined);
    if (node !== undefined) {
      const timeline = run.timeline.forNode(agentId);
      check("modal: timeline recorded spawn + phase", timeline.some((e) => e.icon === "phase" && e.text === "waiting"));
      const data = {
        label: node.label, icon: node.status, phase: node.phase, depth: node.depth,
        model: node.model, tokens: node.tokens, detail: node.detail, timeline,
      };
      const modal = buildModalLines(data, 0, 64, theme);
      check("modal: title in top border", modal[0]?.includes(node.label) === true);
      check("modal: tokens shown", modal.some((l) => l.includes("tokens 100")));
      check("modal: timeline entry shown", modal.some((l) => l.includes("waiting")));
      check("modal: no cost", modal.every((l) => !l.includes("$")));
      const modal2 = buildModalLines({ ...data, timeline: [] }, 0, 64, theme);
      check("modal: stable height regardless of timeline", modal.length === modal2.length);
      check("modal: height within layout budget", modal.length <= MODAL_LAYOUT.timelineVisible + 14);
    }
  }
  store.dispose();
  emitter.shutdown();
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
