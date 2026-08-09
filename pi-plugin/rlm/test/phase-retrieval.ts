/**
 * Deterministic retrieval + one-line delegation primitives (worker.py).
 *
 * These exist to stop context decay: the RLM paper's trajectories retrieve with model-authored
 * regex (App. E.1), which small/fast models do badly, and a bad first decomposition dispropor-
 * tionately decides the outcome (§5, Fig. 4a). `search`/`grep_context`/`outline` make retrieval
 * deterministic and token-free; `map_files`/`llm_map_reduce` make delegating cheaper than
 * hand-rolling a chunk loop. Everything here runs against the REAL Python sandbox.
 */

import { check, failureCount } from "./helpers.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

/** Two files with a clear lexical winner, plus a long file whose definition sits past the noise. */
const FIXTURE = [
  {
    path: "src/config/settings.ts",
    content:
      "export function resolveModelId(registry: ModelRegistry, ref?: string) {\n"
      + "  return registry.find(ref);\n}\n"
      + "export function modelRef(model) { return model.id; }\n",
    tokens: 30,
  },
  {
    path: "src/core/engine.ts",
    content: `${Array.from({ length: 120 }, (_, i) => `// filler line ${i}`).join("\n")
      }\nexport function createEngine(deps) {\n  const limits = new LimitGuard();\n}\n`,
    tokens: 500,
  },
  { path: "docs/README.md", content: "## Install\nrun it\n## Usage\nresolve the model id yourself\n", tokens: 20 },
];

/** Reads a JSON value the sandbox printed on its own line. */
function parsePrinted(stdout: string): unknown {
  const line = stdout.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // Stub sub-LLM handlers: echo the prompt length so we can count fan-out shape without tokens.
  let batchCalls = 0;
  let batchSizes: number[] = [];
  let singleCalls = 0;
  const sandbox = await PythonSandbox.spawn({
    depth: 0,
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 4_000,
    handlers: {
      llmQuery: async (prompt) => { singleCalls++; return `ONE:${prompt.length}`; },
      llmQueryBatched: async (prompts) => {
        batchCalls++;
        batchSizes.push(prompts.length);
        return prompts.map((p) => `ANS:${p.length}`);
      },
    },
  });

  try {
    await sandbox.loadContext(FIXTURE);

    // ── search: BM25 ranking ──────────────────────────────────────────────────────────────
    let r = await sandbox.exec(
      'import json\nhits = search("resolve model id", k=3)\nprint(json.dumps([[h["path"], h["line"]] for h in hits]))',
    );
    let got = parsePrinted(r.stdout);
    const ranked = Array.isArray(got) ? (got as [string, number][]) : [];
    check("search ranks the defining file first",
      ranked[0]?.[0] === "src/config/settings.ts", JSON.stringify(ranked));
    check("search matches camelCase parts (resolveModelId ← 'resolve model id')",
      ranked.length >= 1, JSON.stringify(ranked));

    r = await sandbox.exec(
      'print(json.dumps([h["path"] for h in search("install usage", k=5, path_glob="docs/*")]))',
    );
    got = parsePrinted(r.stdout);
    check("search honours path_glob",
      Array.isArray(got) && got.length > 0 && got.every((p) => String(p).startsWith("docs/")),
      JSON.stringify(got));

    r = await sandbox.exec('print(json.dumps(search("zzzznotpresentanywhere", k=5)))');
    check("search returns [] for a miss", JSON.stringify(parsePrinted(r.stdout)) === "[]", r.stdout.trim());

    r = await sandbox.exec('h = search("resolve model id", k=1)[0]\nprint(json.dumps(sorted(h.keys())))');
    check("search hit shape is {line, path, score, snippet}",
      JSON.stringify(parsePrinted(r.stdout)) === '["line","path","score","snippet"]', r.stdout.trim());

    // ── grep_context: capped hits, complete counts ────────────────────────────────────────
    r = await sandbox.exec(
      'g = grep_context(r"export function", k=2)\n'
      + 'print(json.dumps({"total": g["total"], "hits": len(g["hits"]), "counts": g["counts"], "truncated": g["truncated"]}))',
    );
    const g = parsePrinted(r.stdout) as { total: number; hits: number; counts: Record<string, number>; truncated: boolean } | undefined;
    check("grep_context caps hits at k", g?.hits === 2, JSON.stringify(g));
    check("grep_context reports the complete total past the cap", g?.total === 3, JSON.stringify(g));
    check("grep_context counts stay complete when hits are capped",
      g?.counts["src/config/settings.ts"] === 2 && g?.counts["src/core/engine.ts"] === 1, JSON.stringify(g));
    check("grep_context flags truncation", g?.truncated === true, JSON.stringify(g));

    r = await sandbox.exec('print(json.dumps(grep_context("[unclosed").get("error", "")))');
    check("grep_context returns an error string for a bad regex",
      String(parsePrinted(r.stdout) ?? "").startsWith("bad regex"), r.stdout.trim());

    r = await sandbox.exec('print(json.dumps(len(grep_context(r"^## ", k=10, path_glob="docs/*")["hits"])))');
    check("grep_context honours path_glob", parsePrinted(r.stdout) === 2, r.stdout.trim());

    // ── outline ──────────────────────────────────────────────────────────────────────────
    r = await sandbox.exec('print(json.dumps(outline("engine.ts")))');
    const outline = String(parsePrinted(r.stdout) ?? "");
    check("outline resolves a path by suffix", outline.startsWith("# src/core/engine.ts"), outline.slice(0, 60));
    check("outline finds a definition buried past 120 filler lines",
      outline.includes("121: export function createEngine"), outline.slice(0, 200));
    check("outline stays small (orientation, not a dump)", outline.length < 500, `${outline.length} chars`);

    r = await sandbox.exec('print(json.dumps(outline("does-not-exist.ts")))');
    check("outline reports a miss instead of raising",
      String(parsePrinted(r.stdout) ?? "").startsWith("Error: no context file"), r.stdout.trim());

    // ── index invalidation ───────────────────────────────────────────────────────────────
    r = await sandbox.exec(
      'context.append({"path": "lib/x/a.py", "content": "def brandnewsymbol():\\n    pass\\n", "tokens": 5})\n'
      + 'print(json.dumps([h["path"] for h in search("brandnewsymbol", k=2)]))',
    );
    check("search index invalidates when context grows (add_context path)",
      JSON.stringify(parsePrinted(r.stdout)) === '["lib/x/a.py"]', r.stdout.trim());

    // ── map_files: one batch, not one call per file ──────────────────────────────────────
    batchCalls = 0; batchSizes = [];
    r = await sandbox.exec(
      'out = map_files(["src/config/settings.ts", "docs/README.md"], "Summarize")\n'
      + "print(json.dumps(sorted(out.keys())))",
    );
    check("map_files returns one entry per requested path",
      JSON.stringify(parsePrinted(r.stdout)) === '["docs/README.md","src/config/settings.ts"]', r.stdout.trim());
    check("map_files issues ONE batched call for two files",
      batchCalls === 1 && batchSizes[0] === 2, `calls=${batchCalls} sizes=${JSON.stringify(batchSizes)}`);

    batchCalls = 0; batchSizes = [];
    r = await sandbox.exec('print(json.dumps(sorted(map_files(context[:2], "Summarize").keys())))');
    check("map_files accepts context entries as well as paths",
      JSON.stringify(parsePrinted(r.stdout)) === '["src/config/settings.ts","src/core/engine.ts"]', r.stdout.trim());
    check("map_files still batches when given entries", batchCalls === 1, `calls=${batchCalls}`);

    // engine.ts is ~2.2K chars and the cap is 4K, so force chunking with a long prompt.
    batchCalls = 0; batchSizes = [];
    r = await sandbox.exec(
      'long_prompt = "Q" * 2500\n'
      + 'out = map_files(["src/core/engine.ts"], long_prompt)\n'
      + 'print(json.dumps(out["src/core/engine.ts"].count("ANS:") > 1))',
    );
    check("map_files splits a file that exceeds the per-call budget",
      parsePrinted(r.stdout) === true, `${r.stdout.trim()} sizes=${JSON.stringify(batchSizes)}`);

    // ── spawn(map_files): detached, awaited in a LATER exec, same result shape ────────────
    // map_files is the documented default for bulk reading, so it has to be spawnable — the
    // glossary promised it while the allowlist refused it.
    batchCalls = 0; batchSizes = [];
    r = await sandbox.exec(
      't = spawn(map_files, ["src/config/settings.ts", "docs/README.md"], "Summarize")\n'
      + 'print(json.dumps([type(t).__name__, t.done]))',
    );
    check("spawn(map_files) returns a Task without awaiting it",
      JSON.stringify(parsePrinted(r.stdout)) === '["Task",false]', r.stdout.trim());
    check("spawned map_files posts its batch immediately", batchCalls === 1, `calls=${batchCalls}`);

    r = await sandbox.exec('print(json.dumps(sorted(rlm_await(t).keys())))');
    check("rlm_await(map_files task) yields the same {path: answer} dict",
      JSON.stringify(parsePrinted(r.stdout)) === '["docs/README.md","src/config/settings.ts"]', r.stdout.trim());

    // ── llm_map_reduce: map batch then a single reduce ───────────────────────────────────
    batchCalls = 0; batchSizes = []; singleCalls = 0;
    r = await sandbox.exec('print(json.dumps(llm_map_reduce(context[:3], "Summarize", "Combine")))');
    check("llm_map_reduce maps in one batch then reduces once",
      batchCalls === 1 && batchSizes[0] === 3 && singleCalls === 1,
      `batch=${batchCalls}/${JSON.stringify(batchSizes)} single=${singleCalls}`);
    check("llm_map_reduce returns the reduce answer",
      String(parsePrinted(r.stdout) ?? "").startsWith("ONE:"), r.stdout.trim());

    r = await sandbox.exec('print(json.dumps(llm_map_reduce([], "m", "r")))');
    check("llm_map_reduce reports empty input instead of raising",
      String(parsePrinted(r.stdout) ?? "").startsWith("Error:"), r.stdout.trim());

    // ── answers/plan memo (paper App. C.3) ───────────────────────────────────────────────
    await sandbox.exec('answers["node_0"] = "42"\nplan["nodes"] = ["node_0"]');
    r = await sandbox.exec('print(json.dumps([answers.get("node_0"), plan.get("nodes")]))');
    check("answers/plan persist across repl calls",
      JSON.stringify(parsePrinted(r.stdout)) === '["42",["node_0"]]', r.stdout.trim());

    r = await sandbox.exec("del answers\nprint(json.dumps(None))");
    check("deleting answers does not raise", !r.raised, r.stderr.slice(0, 120));
    r = await sandbox.exec('print(json.dumps(answers))');
    check("answers is re-seeded empty after deletion",
      JSON.stringify(parsePrinted(r.stdout)) === "{}", r.stdout.trim());

    r = await sandbox.exec('print(json.dumps(sorted(n for n in SHOW_VARS().split() if "answers" in n or "plan" in n)))');
    check("answers/plan are user-visible in SHOW_VARS (so they get snapshotted)",
      r.stdout.includes("answers") && r.stdout.includes("plan"), r.stdout.trim());
  } finally {
    await sandbox.dispose();
  }

  if (failureCount() > 0) {
    console.log(`\n✗ ${failureCount()} failure(s)`);
    process.exit(1);
  }
  console.log("\n✓ retrieval + delegation primitives OK");
}

await main();
