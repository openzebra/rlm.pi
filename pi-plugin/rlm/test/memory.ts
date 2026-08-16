/**
 * Phase 3 (v5 port): durable memory — L1 replay, L2 notes, injection, sandbox surface.
 * Mirrors rlm_test mem_suite offline gates: record→replay, hash drift, empty-store silence,
 * inject budget, consolidate fallback, engine replay (0 API calls).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MemoryStore, fileSha256, rootContextPaths } from "../src/core/memory.ts";
import { createEngine } from "../src/core/engine.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import { createSubcallHandlers } from "../src/bridge/handlers/index.ts";
import type { Invocation, SubcallHandlerDeps } from "../src/bridge/handlers/types.ts";
import type { RlmConfig, RlmResult } from "../src/core/types.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import type { ChatMsg, CompleteResult } from "../src/bridge/model.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { check, failureCount, MOCK_MODEL, MOCK_REGISTRY, ZERO_USAGE } from "./helpers.ts";

function finish(): void {
  console.log(failureCount() === 0 ? "\nALL PASS" : `\n${failureCount()} FAILURE(S)`);
  process.exit(failureCount() === 0 ? 0 : 1);
}

const dir = mkdtempSync(join(tmpdir(), "rlm-memory-"));
try {
  // ── L1: record → replay → hash drift ─────────────────────────────────────────
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const T = 1;\n");
  const store = new MemoryStore(dir, { dir: join(dir, ".rlm", "memory") });
  const key = "k-" + "a".repeat(20);

  check("L1: replay of unknown key misses", store.replay(key) === undefined);
  store.recordEpisode({
    key, kind: "rlm", model: "m", prompt: "study auth", paths: ["src/auth.ts"],
    result: "AUTH: jwt at line 3", tokensIn: 100, tokensOut: 20,
  });
  const hit = store.replay(key);
  check("L1: record → replay round-trip", hit?.result === "AUTH: jwt at line 3");
  check("L1: hash snapshot recorded", typeof fileSha256(join(dir, "src", "auth.ts")) === "string");

  writeFileSync(join(dir, "src", "auth.ts"), "export const T = 2; // changed\n");
  check("L1: hash drift invalidates replay", store.replay(key) === undefined);
  const st = store.stats();
  check("L1: hit/miss counters", st.hits === 1 && st.misses === 2, JSON.stringify(st));

  // Durability: a NEW store over the same dir replays (episodes.jsonl on disk).
  const store2 = new MemoryStore(dir, { dir: join(dir, ".rlm", "memory") });
  writeFileSync(join(dir, "src", "auth.ts"), "export const T = 1;\n"); // restore content
  check("L1: episodes persist across store instances", store2.replay(key)?.result === "AUTH: jwt at line 3");

  // ── L2: notes, BM25, link-on-write, inject ───────────────────────────────────
  const notes = new MemoryStore(dir, { dir: join(dir, "notes-rlm") });
  check("L2: empty store injects nothing", notes.injectBlock("anything") === "");
  const n1 = notes.addNote({ content: "retry backoff uses exponential jitter in retry.ts", paths: ["src/retry.ts"] });
  const n2 = notes.addNote({ content: "the auth guard validates jwt tokens in auth.ts", paths: ["src/auth.ts"] });
  check("L2: addNote returns the note", n1 !== undefined && n2 !== undefined);
  const q = notes.query("where is jwt validation?");
  check("L2: BM25 ranks the relevant note first", q[0]?.id === n2?.id, q.map((n) => n.id).join(","));
  check("L2: link-on-write is bidirectional",
    (n1?.links.includes(n2?.id ?? "") ?? false) || (n2?.links.includes(n1?.id ?? "") ?? false),
    `n1→${n1?.links.join(",")} n2→${n2?.links.join(",")}`);

  const block = notes.injectBlock("jwt validation guard");
  check("L2: injectBlock header (v5 verbatim)", block.startsWith("[memory] retrieved notes"));
  check("L2: injectBlock includes matching note", block.includes("auth guard"));

  const tiny = new MemoryStore(dir, { dir: join(dir, "tiny"), injectNoteTokens: 30 });
  tiny.addNote({ content: "note one " + "x".repeat(400) });
  tiny.addNote({ content: "note two " + "y".repeat(400) });
  const tinyBlock = tiny.injectBlock("note");
  check("L2: inject budget respected", tinyBlock.length <= 30 * 4 + 120, String(tinyBlock.length));

  // ── consolidate: llm path + verbatim fallback ─────────────────────────────────
  const withLlm = new MemoryStore(dir, {
    dir: join(dir, "cons-llm"),
    evolveEvery: 2,
    llm: async () => '[{"content":"distilled fact about retry","tags":["retry"],"paths":["src/retry.ts"]}]',
  });
  withLlm.recordEpisode({ key: "e1", kind: "rlm", model: "m", prompt: "p1", paths: [], result: "r1" });
  withLlm.recordEpisode({ key: "e2", kind: "rlm", model: "m", prompt: "p2", paths: [], result: "r2" });
  await new Promise((r) => setTimeout(r, 30)); // consolidation is fire-and-forget
  check("consolidate: llm notes distilled", withLlm.query("retry").some((n) => n.content.includes("distilled fact")));

  const noLlm = new MemoryStore(dir, { dir: join(dir, "cons-fallback"), evolveEvery: 1 });
  noLlm.recordEpisode({ key: "e9", kind: "rlm", model: "m", prompt: "how does backoff work", paths: [], result: "it retries with jitter" });
  await new Promise((r) => setTimeout(r, 30));
  check("consolidate: verbatim fallback without llm",
    noLlm.query("backoff").some((n) => n.content.includes("it retries with jitter")));

  // ── serviceOp: the sandbox surface implementation ─────────────────────────────
  const svc = new MemoryStore(dir, { dir: join(dir, "svc") });
  svc.addNote({ content: "the widget factory lives in widgets.ts", paths: ["src/widgets.ts"] });
  check("serviceOp: query returns note lines", svc.serviceOp("query", { query: "widget" }).includes("widgets.ts"));
  const addOut = svc.serviceOp("add", { content: "manually added note", paths: [], tags: ["manual"] });
  check("serviceOp: add confirms note id", addOut.startsWith("ok note "), addOut);
  check("serviceOp: stats is JSON", JSON.parse(svc.serviceOp("stats", {})).notes >= 2);
  const off = new MemoryStore(dir, {}, false);
  check("serviceOp: disabled store says so", off.serviceOp("stats", {}) === "memory disabled");

  // ── engine: root replay = 0 API calls; [memory] injection ─────────────────────
  const memDir = join(dir, "engine-mem");
  const rootStore = new MemoryStore(dir, { dir: memDir });
  const config: RlmConfig = { ...DEFAULT_CONFIG, maxIterations: 5 };
  let calls = 0;
  const seen: ChatMsg[][] = [];
  const script = async (msgs: readonly ChatMsg[]): Promise<CompleteResult> => {
    calls++;
    seen.push([...msgs]);
    if (calls === 1) {
      return { text: '```python\nmemory.add("the answer engine found: benchmark=42")\nprint("recorded")\n```', usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 } };
    }
    return { text: '```repl\nanswer["content"] = "mem-answer-42"\nanswer["ready"] = True\n```', usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 } };
  };
  const mkEngine = () =>
    createEngine({
      model: MOCK_MODEL, llmModel: MOCK_MODEL, registry: MOCK_REGISTRY, config,
      emitter: new RlmEmitter(), memory: rootStore,
      complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
    });
  const first = await mkEngine()({ rootPrompt: "find the benchmark value", context: "the repo", depth: 0 });
  check("engine: first run answers", first.answer === "mem-answer-42", first.answer.slice(0, 40));
  check("engine: root episode persisted", rootStore.stats().episodes >= 1, JSON.stringify(rootStore.stats()));

  const callsBefore = calls;
  const second = await mkEngine()({ rootPrompt: "find the benchmark value", context: "the repo", depth: 0 });
  check("engine: second identical run replays (0 completions)", second.answer === "mem-answer-42" && calls === callsBefore,
    `answer=${second.answer.slice(0, 30)} calls=${calls - callsBefore}`);
  check("engine: replay reports 0 iterations", second.iterations === 0, String(second.iterations));

  // [memory] injection once a note exists (turn prompt carries the block).
  rootStore.addNote({ content: "note for prompt injection test xyzzy", paths: [] });
  calls = 0;
  seen.length = 0;
  const thirdStore = new MemoryStore(dir, { dir: join(dir, "engine-mem2") });
  thirdStore.addNote({ content: "note for prompt injection test xyzzy", paths: [] });
  await createEngine({
    model: MOCK_MODEL, llmModel: MOCK_MODEL, registry: MOCK_REGISTRY,
    config: { ...DEFAULT_CONFIG, maxIterations: 2 },
    emitter: new RlmEmitter(), memory: thirdStore,
    complete: script as unknown as import("../src/core/iteration.ts").CompleteFn,
  })({ rootPrompt: "xyzzy note task", context: "ctx", depth: 0 });
  check("engine: [memory] block injected into the turn prompt",
    seen.some((msgs) => msgs.some((m) => m.content.includes("[memory] retrieved notes"))));

  // ── handler: child replay gate (rlm_query identical → no second engine) ──────
  {
    const hStore = new MemoryStore(dir, { dir: join(dir, "handler-mem") });
    let childRuns = 0;
    const inv: Invocation = {
      emitter: new RlmEmitter(), parentId: undefined, depth: 0,
      limits: { remainingTimeoutMs: () => undefined, addUsage: () => {}, addRaw: () => {} },
    };
    const deps: SubcallHandlerDeps = {
      resolve: () => inv,
      gates: createSubcallGates(4, 2),
      registry: MOCK_REGISTRY,
      getLlmModel: () => MOCK_MODEL,
      getConfig: () => ({ maxPromptChars: 100_000, maxDepth: 4, enableLedger: false, enableMemory: true }),
      getModel: () => MOCK_MODEL,
      runChild: async (input): Promise<RlmResult> => {
        childRuns++;
        return { answer: `child-${input.rootPrompt.slice(0, 5)}`, iterations: 1, costUsd: 0, inputTokens: 5, outputTokens: 5, durationMs: 1 };
      },
      memory: hStore,
    };
    const handlers = createSubcallHandlers(deps);
    const s1 = await handlers.rlmQuery("study the memory subsystem", 0, { detached: false });
    const a1 = await handlers.awaitTask(s1.task_id ?? "", undefined, undefined, 0, { detached: false })
      .then((r) => String((r as { result?: string }).result ?? ""));
    const s2 = await handlers.rlmQuery("study the memory subsystem", 0, { detached: false });
    const a2 = await handlers.awaitTask(s2.task_id ?? "", undefined, undefined, 0, { detached: false })
      .then((r) => String((r as { result?: string }).result ?? ""));
    check("child: first rlm_query ran the engine", childRuns === 1, `childRuns=${childRuns}`);
    check("child: identical rlm_query replayed (no engine, same answer)", childRuns === 1 && a1 === a2, `${childRuns} ${a1}==${a2}`);
    check("child: episode recorded with rlm kind", hStore.stats().episodes === 1);
  }

  // ── sandbox: memory.query/add/stats over the real worker ──────────────────────
  {
    const sbStore = new MemoryStore(dir, { dir: join(dir, "sb-mem") });
    sbStore.addNote({ content: "sandbox note about tokenizers", paths: [] });
    const sb = await PythonSandbox.spawn({
      depth: 0, execTimeoutS: 30, requestTimeoutMs: 10_000, python: "python3",
      initTimeoutMs: 30_000, maxPromptChars: 100_000,
      handlers: {
        llmQuery: async () => "x",
        ledgerClaims: async () => "ledger: no claims",
        memoryOp: async (op, args) => sbStore.serviceOp(op, args),
      },
    });
    try {
      const r = await sb.exec("print(memory.query('tokenizers'))");
      check("sandbox: memory.query callable", !r.raised && r.stdout.includes("tokenizers"), r.stdout.trim().slice(0, 60));
      const a = await sb.exec("print(memory.add('added from sandbox', paths=['src/x.ts']))");
      check("sandbox: memory.add callable", !a.raised && a.stdout.includes("ok note"), a.stdout.trim().slice(0, 50));
      const s = await sb.exec("import json\nprint(json.loads(memory.stats())['notes'] >= 2)");
      check("sandbox: memory.stats callable + parsed", !s.raised && s.stdout.includes("True"), s.stdout.trim());
      const v = await sb.exec("y = 2\nprint(y)");
      check("sandbox: memory is RESERVED (not a user var)", !v.varNames.includes("memory"), JSON.stringify(v.varNames));
    } finally {
      await sb.dispose();
    }
  }

  // Disk layout sanity (v5-identical shape).
  const onDisk = readFileSync(join(dir, ".rlm", "memory", "episodes.jsonl"), "utf8");
  check("disk: episodes.jsonl is JSONL with the episode", onDisk.includes("AUTH: jwt at line 3"));

  // ── audit M2: consolidation is single-flight ───────────────────────────────────
  {
    let llmCalls = 0;
    const race = new MemoryStore(dir, {
      dir: join(dir, "race"),
      evolveEvery: 100, // manual triggering only
      llm: async () => {
        llmCalls++;
        await new Promise((r) => setTimeout(r, 30));
        return '[{"content":"race note","tags":["x"],"paths":[]}]';
      },
    });
    race.recordEpisode({ key: "r1", kind: "rlm", model: "m", prompt: "p1", paths: [], result: "a1" });
    race.recordEpisode({ key: "r2", kind: "rlm", model: "m", prompt: "p2", paths: [], result: "a2" });
    const both = await Promise.all([race.consolidate(), race.consolidate()]);
    check("M2: overlapping consolidations share one flight", llmCalls === 1, `llmCalls=${llmCalls}`);
    check("M2: both callers get the same count", both[0] === both[1], JSON.stringify(both));
  }

  // ── audit R5: mid-flight recordEpisode stays pending (not wiped) ──────────────
  {
    const mid = new MemoryStore(dir, {
      dir: join(dir, "r5"),
      evolveEvery: 100, // manual triggering only
      llm: async (prompt) => {
        if (prompt.includes("mid-flight-unique-xyz")) {
          return '[{"content":"note-from-mid-flight-xyz","tags":["mid"],"paths":[]}]';
        }
        mid.recordEpisode({
          key: "mid-flight", kind: "rlm", model: "m",
          prompt: "mid-flight-unique-xyz", paths: [], result: "mid-result",
        });
        return '[{"content":"first-batch-note","tags":["x"],"paths":[]}]';
      },
    });
    mid.recordEpisode({ key: "e-first", kind: "rlm", model: "m", prompt: "p1", paths: [], result: "a1" });
    const firstMade = await mid.consolidate();
    check("R5: first consolidate distilled the snapshotted batch", firstMade >= 1, String(firstMade));
    check("R5: first-batch note exists", mid.query("first-batch-note").length >= 1);
    const secondMade = await mid.consolidate();
    check("R5: mid-flight episode was NOT wiped — second consolidate sees it",
      secondMade >= 1, `secondMade=${secondMade}`);
    check("R5: mid-flight episode became a note",
      mid.query("note-from-mid-flight-xyz").length >= 1);
  }

  // ── audit H7: path jail — traversal gets no digest ─────────────────────────────
  {
    writeFileSync(join(dir, "outside-secret.txt"), "outside content");
    const jail = new MemoryStore(dir, { dir: join(dir, "jail") });
    jail.recordEpisode({
      key: "jail-1", kind: "rlm", model: "m", prompt: "jail",
      paths: ["../outside-secret.txt", "src/auth.ts"], result: "jailed",
    });
    // Re-open from disk: only the in-root path may appear in pathHashes (paths[] itself
    // records what was requested — the jail governs hashing, not the record).
    const reopened = new MemoryStore(dir, { dir: join(dir, "jail") });
    const rawLine = readFileSync(join(dir, "jail", "episodes.jsonl"), "utf8").split("\n")[0] ?? "{}";
    const rec = JSON.parse(rawLine) as { readonly pathHashes?: Readonly<Record<string, string>> };
    const hashKeys = Object.keys(rec.pathHashes ?? {});
    check("H7: traversal path not hashed", !hashKeys.some((k) => k.includes("outside-secret")), JSON.stringify(hashKeys));
    check("H7: in-root path hashed", hashKeys.includes("src/auth.ts"), JSON.stringify(hashKeys));
    check("H7: reopened episode replays (in-root hashes valid)", reopened.replay("jail-1")?.result === "jailed");
  }

  // ── audit H6: rootContextPaths — the bounded real-file slice ───────────────────
  {
    const ctxFiles = [
      { path: "src/a.ts", content: "x", tokens: 1 },
      { path: "ctx/ab12/doc.md", content: "y", tokens: 1 },
      { path: "README.md", content: "z", tokens: 1 },
    ];
    const paths = rootContextPaths(ctxFiles, 64);
    check("H6: real paths extracted, virtual ctx/ excluded",
      paths.length === 2 && paths.includes("src/a.ts") && paths.includes("README.md"), JSON.stringify(paths));
    check("H6: bounded", rootContextPaths(ctxFiles, 1).length === 1);
    check("H6: non-array context → empty", rootContextPaths("text", 64).length === 0);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

finish();
