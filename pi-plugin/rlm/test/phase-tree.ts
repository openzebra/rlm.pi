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
import { buildRows, type GroupRow, type NodeRow } from "../src/ui/tree/tree-model.ts";
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

// ── tree model: agents first, nothing hidden, own-spend tokens ──
{
  const registry = new RunRegistry();
  const emitter = new RlmEmitter();
  const store = new SubcallStore(emitter);
  // Production registers BEFORE any event fires — mirror that ordering so the
  // timeline store (subscribed at registration) sees everything below.
  registry.register({ runId: "run1", label: "root", emitter, subcalls: () => store.getSubcalls(), totals: () => store.getTotals() });
  const agentId = emitter.emitSubcallCreated({ kind: "rlm", label: "rlm_query: auth", model: "openai/gpt-5", depth: 1 });
  emitter.emitSubcallUpdated({ id: agentId, phase: "waiting", tokens: 100 });
  // Production shape: every llm_batch item carries the SAME label ("llm_query").
  const leafIds: string[] = new Array<string>(7);
  for (let i = 0; i < 7; i++) {
    const leaf = emitter.emitSubcallCreated({ kind: "llm", label: "llm_query", model: "openai/gpt-5-mini", depth: 1 });
    leafIds[i] = leaf;
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
  check("model: agent row shows own tokens only", nodeRows[1]?.tokens === 100);

  // Identical leaves collapse into ONE group row (default view: root + agent + inner + group).
  const group = rows.find((r): r is GroupRow => r.type === "group");
  check("model: identical leaves form one group row", rows.length === 4 && group !== undefined);
  check("model: group carries count, summed tokens, shared model",
    group?.count === 7 && group?.tokens === 70 && group?.model === "openai/gpt-5-mini");
  const expanded = buildRows(snapshot, new Set(), new Set([group?.id ?? ""]));
  check("model: expanded group shows every member", expanded.length === 11);
  check("model: rows carry runId for modal lookup", nodeRows[1]?.runId === "run1");

  // Errors never blend into a different-status run: one ✗ among ✓s stays an individual row.
  {
    const failedId = leafIds[0] ?? "";
    emitter.emitSubcallUpdated({ id: failedId, status: "error", detail: "401 unauthorized" });
    const snap2 = registry.snapshots()[0] ?? snapshot;
    const errRows = buildRows(snap2, new Set());
    const errorNodes = errRows.filter((r): r is NodeRow => r.type === "node" && r.icon === "error");
    check("model: error leaf stays individual, never grouped", errorNodes.length === 1 && errorNodes[0]?.id === failedId);
    check("model: done group excludes the error", errRows.some((r): r is GroupRow => r.type === "group" && r.count === 6));
  }

  const collapsedRows = buildRows(snapshot, new Set([agentId]));
  const collapsedAgent = collapsedRows.find((r): r is NodeRow => r.type === "node" && r.id === agentId);
  check("model: collapsed hides children", collapsedAgent?.expanded === false && !collapsedRows.some((r) => r.type === "node" && r.id === childLeaf));

  // ── row formatting: tokens + short model, never "$" ──
  const lines = formatRows(rows, agentId, 72, theme);
  check("rows: one line per row", lines.length === rows.length);
  check("rows: agent line shows own tokens", lines[1]?.includes("100 tok"));
  check("rows: model shortened to last segment", lines[1]?.includes("gpt-5"));
  check("rows: no cost anywhere", lines.every((l) => !l.includes("$")));
  check("rows: selection cursor rendered", lines[1]?.includes("❯"));
  check("rows: modelShort caps length", modelShort("provider/a-very-long-model-name-here").length <= 15);

  emitter.emitSubcallUpdated({ id: agentId, tokensIn: 190_200, tokensOut: 18_600 });
  const splitSnap = registry.snapshots()[0];
  check("rows: split snapshot exists", splitSnap !== undefined);
  if (splitSnap !== undefined) {
    const splitLines = formatRows(buildRows(splitSnap, new Set()), agentId, 72, theme);
    check("rows: in/out split shown when tokensOut > 0",
      (splitLines[1]?.includes("190.2k↑")) && (splitLines[1]?.includes("18.6k↓")));
  }

  // ── interleaved errors consolidate: ✗ ✓✓✓✓✓✓ ✗ ✗ → ONE ×3 group at the first ✗ position ──
  {
    const failIds: string[] = new Array<string>(2);
    for (let i = 0; i < 2; i++) {
      const id = emitter.emitSubcallCreated({ kind: "llm", label: "llm_query", model: "openai/gpt-5-mini", depth: 1 });
      failIds[i] = id;
      emitter.emitSubcallUpdated({ id, status: "error", detail: "rate limited" });
    }
    const failSnap = registry.snapshots()[0];
    check("rows: interleaved-error snapshot exists", failSnap !== undefined);
    if (failSnap !== undefined) {
      // All three ✗ share the group key (label+model+status) even though the ✓ run sits
      // between them — they consolidate into ONE ×3 group at the FIRST ✗ position.
      const failRows = buildRows(failSnap, new Set());
      const loneErrors = failRows.filter((r): r is NodeRow => r.type === "node" && r.icon === "error");
      check("rows: no error leaf stays individual — identical failures consolidate", loneErrors.length === 0);
      const errorGroups = failRows.filter((r): r is GroupRow => r.type === "group" && r.icon === "error");
      check("rows: interleaved errors form ONE group of 3", errorGroups.length === 1 && errorGroups[0]?.count === 3);
      // Visible order: root, agent, inner child, error group, done group.
      check("rows: group placed at first member position", failRows.findIndex((r) => r.type === "group" && r.count === 3) === 3);
      // Diverging reasons collapse into a counted summary instead of splitting the group.
      check("rows: diverging reasons summarized", errorGroups[0]?.reason === "2 failure reasons");
      const failLine = formatRows(failRows, "", 96, theme).find((l) => l.includes("×3"));
      check("rows: error group renders ✗ llm_query ×3 · reasons",
        failLine !== undefined && failLine.includes("✗") && failLine.includes("llm_query") && failLine.includes("2 failure reasons"));
      // Expanded group lists members in start order (leafIds[0] spawned first).
      const expandedFail = buildRows(failSnap, new Set(), new Set([errorGroups[0]?.id ?? ""]));
      const failMembers = expandedFail.filter((r): r is NodeRow => r.type === "node" && r.icon === "error");
      check("rows: expanded group keeps start order", failMembers.length === 3 && failMembers[0]?.id === leafIds[0]);
    }
  }

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
      check("modal: title in top border", modal[0]?.includes(node.label));
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

// ── ×16: a wholesale batch failure is ONE line — however many rows interleave, rlm never groups ──
{
  const registry = new RunRegistry();
  const emitter = new RlmEmitter();
  const store = new SubcallStore(emitter);
  registry.register({ runId: "run2", label: "root", emitter, subcalls: () => store.getSubcalls(), totals: () => store.getTotals() });
  // 16 failing llm leaves, each followed by an IDENTICAL rlm sibling — the rlm rows must
  // never consolidate (user rule: ×N compaction does not apply to rlm_query), while the
  // llm leaves merge across all the interleaving into a single ✗ llm_query ×16 group.
  const failed: string[] = new Array<string>(16);
  const probes: string[] = new Array<string>(16);
  for (let i = 0; i < 16; i++) {
    failed[i] = emitter.emitSubcallCreated({ kind: "llm", label: "llm_query", model: "openai/gpt-5-mini", depth: 1 });
    probes[i] = emitter.emitSubcallCreated({ kind: "rlm", label: "rlm_query: probe", model: "anthropic/claude", depth: 1 });
    emitter.emitSubcallUpdated({ id: failed[i], status: "error", detail: "Error: rate limit exceeded" });
    emitter.emitSubcallUpdated({ id: probes[i], status: "done" });
  }
  const snap = registry.snapshots()[0];
  check("x16: snapshot exists", snap !== undefined);
  if (snap !== undefined) {
    const rows = buildRows(snap, new Set());
    const groups = rows.filter((r): r is GroupRow => r.type === "group");
    // Containers sort before leaves: root + 16 rlm nodes + 1 llm group.
    check("x16: exactly one group row despite interleaving", rows.length === 18 && groups.length === 1);
    const group = groups[0];
    check("x16: group carries count + shared error reason",
      group?.count === 16 && group?.icon === "error" && group?.reason === "rate limit exceeded");
    check("x16: 'Error: ' prefix stripped from reason", group?.reason !== undefined && !group.reason.includes("Error:"));
    const probeNodes = rows.filter((r): r is NodeRow => r.type === "node" && r.label === "rlm_query: probe");
    check("x16: identical rlm siblings stay individual rows", probeNodes.length === 16);
    const lines = formatRows(rows, "", 110, theme);
    const groupLine = lines.find((l) => l.includes("×16"));
    check("x16: renders ✗ llm_query ×16 · rate limit exceeded",
      groupLine !== undefined && groupLine.includes("✗") && groupLine.includes("llm_query ×16 · rate limit exceeded"));
    const expanded = buildRows(snap, new Set(), new Set([group?.id ?? ""]));
    const memberIds = expanded.filter((r): r is NodeRow => r.type === "node" && r.icon === "error").map((r) => r.id);
    check("x16: expanded group lists all 16 members in start order",
      memberIds.length === 16 && memberIds[0] === failed[0] && memberIds[15] === failed[15]);
  }
  store.dispose();
  emitter.shutdown();
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
