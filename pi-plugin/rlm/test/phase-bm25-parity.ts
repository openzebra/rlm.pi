/**
 * BM25 DUALITY parity (AGENTS.md convention): the sandbox scorer (`retrieval.py`) and the
 * host scorer (`util/bm25.ts`) must rank IDENTICALLY — same corpus, same queries, same order,
 * same scores — including the V2 pipeline (stemmer, PRF expansion, phrase bonus). Window
 * mechanics that are Python-only by design (overlap, glob pre-filter, adjacent-window merge)
 * are exercised in phase-retrieval.ts; here every corpus file fits ONE window so the compared
 * artifact is the pure ranking.
 */

import { check, failureCount } from "./helpers.ts";
import { bm25Rank, bm25Tokenize, type Bm25Entry } from "../src/util/bm25.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";

/** Clustered mini-corpus: 14 files × ≤40 lines → one window each (≥ PRF_MIN_DOCS=12). */
const FILES: readonly (readonly [path: string, content: string])[] = Object.freeze([
  ["a1/registry.ts", "resolveModelId(registry, ref)\nfind the model in the registry\nmodel ids are resolved by ref\n".repeat(3)],
  ["a2/registry.md", "the registry resolves model refs\nmodel registry lookup helpers\nresolve a model id first\n".repeat(3)],
  ["a3/models.ts", "export const models = [model]\nmodel ref resolution\nregistry.find(ref) returns the model\n".repeat(3)],
  ["b1/engine.ts", "createEngine(deps) builds the engine\nthe engine loop drives turns\nengine limits guard the run\n".repeat(3)],
  ["b2/limits.ts", "LimitGuard caps wall clock\nlimits guard errors and tokens\nengine guard raised errors\n".repeat(3)],
  ["b3/loop.ts", "the engine loop iterates turns\nloop drives the model turn by turn\ncreated engines resume state\n".repeat(3)],
  ["c1/archive.ts", "session archive stores elided turns\narchive segments recall elided chat\nturns archived under ctx session log\n".repeat(3)],
  ["c2/log.md", "the session log keeps archived turns\nelided payloads stay in the log\nlog recall searches archived text\n".repeat(3)],
  ["c3/recall.ts", "recall stubs point into the archive\narchived turns are searchable\nrecall the elided session text\n".repeat(3)],
  ["d1/config.json", "skillStateNotesPerProject 128\nskillStateMaxTokens budget config\nconfig defaults are frozen\n".repeat(3)],
  ["d2/settings.ts", "settings validate numbers and booleans\nthe settings loader resolves models\nvalidate the config values\n".repeat(3)],
  ["d3/env.md", "environment tips for orchestration\ndecomposition doctrine env tips\nthe environment is a python repl\n".repeat(3)],
  ["e1/parser.ts", "findReplBlocks parses fenced code\nthe parser extracts repl blocks\nparsing fenced blocks regex\n".repeat(3)],
  ["e2/tokens.ts", "estimateTokens counts chars per token\ntoken estimation for budgets\nestimate tokens from chars\n".repeat(3)],
]);

/** Queries chosen to exercise stemming, phrase adjacency, and PRF expansion. */
const QUERIES: readonly string[] = Object.freeze([
  "resolve model registry",
  "created engines and limits",
  "archived session turns recall",
  "the engine loop drives turns",
  "settings validate config values",
]);

const WORDS: readonly string[] = Object.freeze([
  // plural folds
  "files", "file", "names", "name", "cats", "cat", "boxes", "box", "matches", "match",
  "classes", "class", "studies", "study", "categories", "category", "movies", "movie",
  "runs", "run", "uses", "use", "trees", "tree",
  // ing/ed folds
  "running", "run", "mapping", "map", "settings", "set", "linked", "link", "archived",
  "archive", "created", "create", "creates", "coded", "code", "coding", "indexing",
  "indexes", "index", "testing", "tested",
  // protected forms
  "string", "strings", "thing", "this", "was", "its", "analysis", "basis", "class", "ss",
  // short + non-ascii passthrough
  "a", "ab", "abc", "初語", "ごみ",
]);

function parseJsonLine(stdout: string): unknown {
  const line = stdout.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const sandbox = await PythonSandbox.spawn({
    depth: 0,
    execTimeoutS: 30,
    requestTimeoutMs: 30_000,
    python: "python3",
    initTimeoutMs: 30_000,
    maxPromptChars: 4_000,
    handlers: {},
  });

  try {
    // ── tokenizer/stemmer parity: identical token lists per word ───────────────────────────
    const wordsLit = JSON.stringify(WORDS);
    const r = await sandbox.exec(
      `import json, retrieval\nwords = json.loads(${JSON.stringify(wordsLit)})\n`
      + "print(json.dumps([retrieval._tokenize(w) for w in words]))",
    );
    const pyTokens = parseJsonLine(r.stdout);
    let tokenMismatches = 0;
    if (Array.isArray(pyTokens)) {
      for (let i = 0; i < WORDS.length; i++) {
        const ts = bm25Tokenize(WORDS[i]).join(",");
        const py = (pyTokens[i] as string[]).join(",");
        if (ts !== py) {
          tokenMismatches++;
          console.log(`  tokenize diverge: ${WORDS[i]}  ts=[${ts}]  py=[${py}]`);
        }
      }
    } else {
      tokenMismatches = 1;
    }
    check(`stemmer/tokenizer parity across ${WORDS.length} probe words`, tokenMismatches === 0,
      `${tokenMismatches} mismatch(es)`);

    // ── ranking parity: same corpus, same queries, same order + scores ─────────────────────
    await sandbox.loadContext(FILES.map(([path, content]) => ({ path, content, tokens: 40 })));
    const entries: readonly Bm25Entry<string>[] = FILES.map(([path, content]) => ({
      item: path,
      text: content, // single window: whole file is the retrieval unit on both sides
    }));

    for (const query of QUERIES) {
      const qLit = JSON.stringify(query);
      const rq = await sandbox.exec(
        `import json\nhits = search(${qLit}, k=6)\n`
        + 'print(json.dumps([[h["path"], h["score"]] for h in hits]))',
      );
      const pyHits = parseJsonLine(rq.stdout);
      const tsHits = bm25Rank(query, entries, 6);
      if (!Array.isArray(pyHits)) {
        check(`ranking parity "${query}"`, false, `bad sandbox output: ${rq.stdout.trim()}`);
        continue;
      }
      const pyRanked = pyHits as [string, number][];
      const orderOk = pyRanked.length === tsHits.length
        && pyRanked.every(([p], i) => p === tsHits[i].item);
      const scoreOk = pyRanked.every(([, s], i) => Math.abs(s - tsHits[i].score) <= 0.0011);
      check(`ranking parity "${query}"`, orderOk && scoreOk,
        `py=${JSON.stringify(pyRanked)} ts=${JSON.stringify(tsHits.map((h) => [h.item, Number(h.score.toFixed(3))]))}`);
    }
  } finally {
    await sandbox.dispose();
  }

  if (failureCount() > 0) {
    console.log(`\n✗ ${failureCount()} failure(s)`);
    process.exit(1);
  }
  console.log("\n✓ BM25 duality parity OK");
}

await main();
