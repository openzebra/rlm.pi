/**
 * load_library() — resolver, worker round-trip, prompt gating, resume sidecars.
 * Run: bun run pi-plugin/rlm/test/phase-library.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failureCount } from "./helpers.ts";
import {
  contextEntryPath,
  filterContextByPaths,
  isContextFile,
  libraryNamespace,
  libraryPathPrefix,
  libraryPrefixesIn,
  librarySourceId,
  MAX_LIBRARY_FILE_BYTES,
  mergeLibraryIntoContext,
  namespaceLibraryFiles,
  namespaceLibraryFilesWithChars,
  payloadPrefix,
  resolveLibrarySource,
} from "../src/context/library-context.ts";
import { pinContext, pinnedCount } from "../src/sandbox/context-file.ts";
import { buildLibraryHandler } from "../src/bridge/library.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { writeContextSidecar } from "../src/state/writes.ts";
import { readLibrarySidecars } from "../src/state/reads.ts";

/** Match `lib/<basename>-<8hex>/…` fingerprinted prefixes. */
function hasLibPrefix(path: string | undefined, basename: string): boolean {
  if (path === undefined) return false;
  return new RegExp(`^lib/${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{8}/`).test(path);
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "rlm-lib-test-"));
  try {
    // 1. Resolver: single file → namespaced list[dict]
    const f = join(tmp, "doc.md");
    const fileText = "# api\nhello";
    await writeFile(f, fileText);
    const r1 = await resolveLibrarySource(f, tmp);
    check(
      "resolver: single file → namespaced list payload",
      r1.ok
        && Array.isArray(r1.value.payload)
        && r1.value.files === 1
        && hasLibPrefix(r1.value.payload[0]?.path, "doc.md"),
      r1.ok ? `path=${r1.value.payload[0]?.path} chars=${r1.value.chars}` : r1.error,
    );
    check(
      "resolver: chars equals content length (not JSON length)",
      r1.ok && r1.value.chars === fileText.length,
      r1.ok ? `chars=${r1.value.chars} content=${fileText.length}` : "fail",
    );

    // 2. Resolver: directory → packed list[dict] under lib/<id>/
    await mkdir(join(tmp, "extlib/src"), { recursive: true });
    await writeFile(join(tmp, "extlib/src/a.ts"), "export const a = 1;");
    const r2 = await resolveLibrarySource(join(tmp, "extlib"), tmp);
    check(
      "resolver: directory → packed namespaced array",
      r2.ok
        && Array.isArray(r2.value.payload)
        && r2.value.files === 1
        && hasLibPrefix(r2.value.payload[0]?.path, "extlib"),
      r2.ok ? `files=${r2.value.files} path=${r2.value.payload[0]?.path}` : r2.error,
    );

    // 3. Resolver: missing path + bad scheme
    const missing = await resolveLibrarySource("./nope", tmp);
    check("resolver: missing path fails", !missing.ok, missing.ok ? "ok unexpectedly" : missing.error);
    const badScheme = await resolveLibrarySource("ftp://x/y", tmp);
    check("resolver: bad URL scheme fails", !badScheme.ok, badScheme.ok ? "ok unexpectedly" : badScheme.error);
    const empty = await resolveLibrarySource("   ", tmp);
    check("resolver: empty source fails", !empty.ok);

    // 3b. Namespace + merge helpers (DRY unit checks)
    const namespaced = namespaceLibraryFiles([{ path: "a.ts", content: "x", tokens: 1 }], "mylib");
    check(
      "namespaceLibraryFiles prefixes paths",
      namespaced.length === 1 && namespaced[0]?.path === "lib/mylib/a.ts",
      namespaced[0]?.path ?? "empty",
    );
    const merged = mergeLibraryIntoContext(
      [{ path: "repo.ts", content: "r", tokens: 1 }],
      namespaced,
    );
    check(
      "mergeLibraryIntoContext concatenates lists",
      Array.isArray(merged) && merged.length === 2,
      Array.isArray(merged) ? `len=${merged.length}` : "not array",
    );
    const sid = librarySourceId("/Users/x/bearby-core", "/Users/x/bearby-core");
    check(
      "librarySourceId fingerprinted basename",
      /^bearby-core-[0-9a-f]{8}$/.test(sid),
      sid,
    );
    const ns = libraryNamespace(f, tmp);
    check(
      "libraryNamespace returns matching id+prefix",
      ns.pathPrefix === `lib/${ns.sourceId}/` && hasLibPrefix(`${ns.pathPrefix}x`, "doc.md"),
      `${ns.sourceId} ${ns.pathPrefix}`,
    );

    // 3c. Basename collision resistance (NEW-1)
    await mkdir(join(tmp, "proj-a", "utils"), { recursive: true });
    await mkdir(join(tmp, "proj-b", "utils"), { recursive: true });
    await writeFile(join(tmp, "proj-a", "utils", "a.ts"), "export const a = 1;");
    await writeFile(join(tmp, "proj-b", "utils", "b.ts"), "export const b = 2;");
    const pathA = join(tmp, "proj-a", "utils");
    const pathB = join(tmp, "proj-b", "utils");
    const prefA = libraryPathPrefix(pathA, tmp);
    const prefB = libraryPathPrefix(pathB, tmp);
    check(
      "collision: same basename → distinct prefixes",
      prefA !== prefB,
      `${prefA} vs ${prefB}`,
    );
    check(
      "collision: same source → stable prefix",
      libraryPathPrefix(pathA, tmp) === prefA,
    );

    // 4. Worker round-trip: append into context (not context_N)
    const sandbox = await PythonSandbox.spawn({
      handlers: {
        loadLibrary: async (source) => ({
          payload: [{ path: `lib/${source}/hi.ts`, content: `LIB:${source}`, tokens: 2 }],
          index: 1,
          files: 1,
          chars: 20,
          sourceId: source,
          pathPrefix: `lib/${source}/`,
        }),
      },
    });
    try {
      await sandbox.loadContext([{ path: "repo.ts", content: "root", tokens: 1 }]);
      const res = await sandbox.exec(
        [
          'info = load_library("mylib")',
          'print(info["source_id"], info["path_prefix"], info["files"], info["context_len"])',
          'print(len(context), context[0]["path"], context[1]["path"], context[1]["content"])',
        ].join("\n"),
      );
      check(
        "worker: load_library appends into single context",
        res.stdout.includes("mylib")
          && res.stdout.includes("lib/mylib/")
          && res.stdout.includes("2 repo.ts")
          && res.stdout.includes("lib/mylib/hi.ts")
          && res.stdout.includes("LIB:mylib"),
        res.stdout.trim().slice(0, 200),
      );

      const resIdem = await sandbox.exec(
        'info2 = load_library("mylib")\nprint(info2["already_loaded"], info2["files"], len(context))',
      );
      check(
        "worker: re-load is idempotent",
        resIdem.stdout.includes("True") && resIdem.stdout.includes("0") && resIdem.stdout.includes("2"),
        resIdem.stdout.trim().slice(0, 120),
      );
    } finally {
      await sandbox.dispose();
    }

    // 5. Error propagation: REJECT default → "Error: ..." string, no exception
    const bare = await PythonSandbox.spawn({});
    try {
      const res2 = await bare.exec('print(load_library("x"))');
      check(
        "worker: REJECT load_library → Error string",
        res2.stdout.trim().startsWith("Error:") && !res2.raised,
        res2.stdout.trim().slice(0, 80),
      );
    } finally {
      await bare.dispose();
    }

    // 5b. Non-list context rejected
    const textCtx = await PythonSandbox.spawn({
      handlers: {
        loadLibrary: async () => ({
          payload: [{ path: "lib/x/a", content: "a", tokens: 1 }],
          index: 1,
          files: 1,
          chars: 1,
          sourceId: "x",
          pathPrefix: "lib/x/",
        }),
      },
    });
    try {
      await textCtx.loadContext("plain text context");
      const resText = await textCtx.exec('print(load_library("x"))');
      check(
        "worker: list context required",
        resText.stdout.includes("requires list context") && !resText.raised,
        resText.stdout.trim().slice(0, 100),
      );
    } finally {
      await textCtx.dispose();
    }

    // 6. Prompt gating
    const meta = { contextType: "json", contextChars: 100 };
    const withLib = buildRlmSystemPrompt(meta, { libraryLoader: true });
    check(
      "prompt: libraryLoader true includes load_library",
      withLib.includes("load_library"),
    );
    check(
      "prompt: libraryLoader documents append into context",
      withLib.includes("APPEND") || withLib.includes("append"),
      withLib.includes("load_library") ? "has load_library" : "missing",
    );
    check(
      "prompt: libraryLoader false omits load_library",
      !buildRlmSystemPrompt(meta, { libraryLoader: false }).includes("load_library"),
    );

    // 7. Sidecar round-trip
    const cwd = tmp;
    const dir = "runs";
    const runId = "2026-01-01_00-00-00-abcd";
    await writeContextSidecar(cwd, dir, runId, [{ path: "lib/mylib/a", content: "x", tokens: 1 }], true, 2);
    const slots = await readLibrarySidecars(cwd, dir, runId);
    check(
      "sidecar: write/read library slot index 2",
      slots.length === 1 && slots[0]?.index === 2 && Array.isArray(slots[0]?.payload),
      `len=${slots.length} idx=${slots[0]?.index}`,
    );
    // slot 0 uses legacy name — must not appear in library lister
    await writeContextSidecar(cwd, dir, runId, "repo context", false, 0);
    const slots2 = await readLibrarySidecars(cwd, dir, runId);
    check(
      "sidecar: slot 0 context.txt not listed as library slot",
      slots2.length === 1 && slots2[0]?.index === 2,
      `len=${slots2.length}`,
    );

    // 8. Git clone error path (unreachable URL, no network success required)
    const gitFail = await resolveLibrarySource("https://127.0.0.1:1/not-a-repo.git", tmp);
    check(
      "resolver: git clone failure returns error",
      !gitFail.ok && gitFail.error.includes("git clone failed"),
      gitFail.ok ? "ok unexpectedly" : gitFail.error.slice(0, 120),
    );

    // 9. Host-side idempotency: one onLoaded call for two loads of the same source
    let onLoadedCalls = 0;
    const bundle = buildLibraryHandler({
      cwd: tmp,
      startIndex: 1,
      onLoaded: async () => { onLoadedCalls++; },
    });
    const first = await bundle.handlers.loadLibrary(f, 0);
    const second = await bundle.handlers.loadLibrary(f, 0);
    check("host: first load packs", first.alreadyLoaded !== true && first.files === 1);
    check("host: second load is alreadyLoaded", second.alreadyLoaded === true && second.files === 0);
    check("host: onLoaded called once", onLoadedCalls === 1, String(onLoadedCalls));
    check("host: loadedPrefixes has one entry", bundle.loadedPrefixes().size === 1);

    // 9b. Distinct basenames must both load (NEW-1 handler-level)
    let collisionLoads = 0;
    const collisionBundle = buildLibraryHandler({
      cwd: tmp,
      startIndex: 1,
      onLoaded: async () => { collisionLoads++; },
    });
    const loadA = await collisionBundle.handlers.loadLibrary(pathA, 0);
    const loadB = await collisionBundle.handlers.loadLibrary(pathB, 0);
    check(
      "collision: proj-a then proj-b both pack",
      loadA.alreadyLoaded !== true && loadB.alreadyLoaded !== true,
      `a=${String(loadA.alreadyLoaded)} b=${String(loadB.alreadyLoaded)}`,
    );
    check("collision: onLoaded fires twice", collisionLoads === 2, String(collisionLoads));
    check(
      "collision: distinct pathPrefixes",
      loadA.pathPrefix !== loadB.pathPrefix,
      `${loadA.pathPrefix} vs ${loadB.pathPrefix}`,
    );

    // Resume merge of identical sidecars yields each path once
    const sideA = namespaceLibraryFiles([{ path: "a.ts", content: "x", tokens: 1 }], "mylib");
    const base = [{ path: "repo.ts", content: "r", tokens: 1 }];
    const once = mergeLibraryIntoContext(base, sideA);
    const twice = mergeLibraryIntoContext(once, sideA);
    check(
      "merge: duplicate library sidecar does not double paths",
      Array.isArray(twice) && twice.length === 2,
      Array.isArray(twice) ? `len=${twice.length}` : "not array",
    );

    // 9c. Merge dedup from non-first entry (NEW-3)
    const mixedPayload = [
      { path: "not-namespaced.ts", content: "z", tokens: 1 },
      { path: "lib/mylib/a.ts", content: "x", tokens: 1 },
    ];
    check(
      "payloadPrefix: finds prefix after non-namespaced head",
      payloadPrefix(mixedPayload) === "lib/mylib/",
      String(payloadPrefix(mixedPayload)),
    );
    const afterMixed = mergeLibraryIntoContext(
      [{ path: "repo.ts", content: "r", tokens: 1 }, { path: "lib/mylib/old.ts", content: "o", tokens: 1 }],
      mixedPayload,
    );
    check(
      "merge: dedups when first entry lacks lib/ prefix",
      Array.isArray(afterMixed) && afterMixed.length === 2,
      Array.isArray(afterMixed) ? `len=${afterMixed.length}` : "not array",
    );

    // Two distinct lib/unknown/ payloads both merge (not treated as identity)
    const unk1 = namespaceLibraryFiles("legacy-a", "unknown");
    const unk2 = namespaceLibraryFiles("legacy-b", "unknown");
    check("payloadPrefix: lib/unknown/ ignored", payloadPrefix(unk1) === undefined);
    const withUnk = mergeLibraryIntoContext([{ path: "repo.ts", content: "r", tokens: 1 }], unk1);
    const withBothUnk = mergeLibraryIntoContext(withUnk, unk2);
    check(
      "merge: two lib/unknown/ payloads both merge",
      Array.isArray(withBothUnk) && withBothUnk.length === 3,
      Array.isArray(withBothUnk) ? `len=${withBothUnk.length}` : "not array",
    );

    // 10. Oversize single-file rejected with llm_query_chunked guidance
    const huge = join(tmp, "huge.bin");
    await writeFile(huge, Buffer.alloc(MAX_LIBRARY_FILE_BYTES + 1, 0x61));
    const over = await resolveLibrarySource(huge, tmp);
    check(
      "resolver: oversize file fails with chunked guidance",
      !over.ok
        && over.error.includes("llm_query_chunked")
        && over.error.includes("limit"),
      over.ok ? "ok unexpectedly" : over.error.slice(0, 160),
    );

    // chars unit: withChars sums content lengths
    const wc = namespaceLibraryFilesWithChars(
      [{ path: "a", content: "hi", tokens: 1 }, { path: "b", content: "there", tokens: 1 }],
      "t",
    );
    check("withChars: sum of content lengths", wc.chars === 7, String(wc.chars));

    // ── Phase 1a primitives ──
    check("isContextFile: accepts a file entry",
      isContextFile({ path: "a.ts", content: "x", tokens: 1 }));
    check("isContextFile: rejects non-file shapes",
      !isContextFile(null) && !isContextFile("a.ts") && !isContextFile({ path: 1, content: "x" }));
    check("contextEntryPath: reads a path, undefined otherwise",
      contextEntryPath({ path: "a.ts", content: "x" }) === "a.ts"
        && contextEntryPath(42) === undefined);

    check("libraryPrefixesIn: empty for a non-array", libraryPrefixesIn("plain text").length === 0);
    const twoLibs = [
      { path: "repo.ts", content: "r", tokens: 1 },
      { path: "lib/one-11111111/a.ts", content: "x", tokens: 1 },
      { path: "lib/two-22222222/b.ts", content: "y", tokens: 1 },
      { path: "lib/one-11111111/c.ts", content: "z", tokens: 1 },
      { path: "lib/unknown/legacy.ts", content: "w", tokens: 1 },
    ];
    const prefixes = libraryPrefixesIn(twoLibs);
    check("libraryPrefixesIn: distinct prefixes, lib/unknown/ skipped",
      prefixes.length === 2 && prefixes.includes("lib/one-11111111/")
        && prefixes.includes("lib/two-22222222/"),
      prefixes.join(","));

    const filteredOne = filterContextByPaths(twoLibs, ["lib/one-11111111/"]);
    check("filterContextByPaths: prefix selects its subtree",
      filteredOne.files.length === 2 && filteredOne.unmatched.length === 0,
      `${filteredOne.files.length} file(s)`);
    const filteredMixed = filterContextByPaths(twoLibs, ["lib/two-22222222/", "nope/"]);
    check("filterContextByPaths: reports prefixes that matched nothing",
      filteredMixed.files.length === 1 && filteredMixed.unmatched.length === 1
        && filteredMixed.unmatched[0] === "nope/",
      filteredMixed.unmatched.join(","));
    check("filterContextByPaths: non-array yields no files, all unmatched",
      filterContextByPaths("text", ["a/"]).files.length === 0
        && filterContextByPaths("text", ["a/"]).unmatched.length === 1);
    check("filterContextByPaths: no prefixes selects nothing",
      filterContextByPaths(twoLibs, []).files.length === 0);

    // ── Accumulator: what a child inherits must grow when a library loads ──
    let accumulated: unknown = [{ path: "repo.ts", content: "r", tokens: 1 }];
    const accBundle = buildLibraryHandler({
      cwd: tmp,
      startIndex: 1,
      getContext: () => accumulated,
      onLoaded: (_i, payload) => { accumulated = mergeLibraryIntoContext(accumulated, payload); },
    });
    await accBundle.handlers.loadLibrary(pathA, 0);
    await accBundle.handlers.loadLibrary(pathB, 0);
    const accPrefixes = libraryPrefixesIn(accumulated);
    check("accumulator: both libraries present after two loads", accPrefixes.length === 2,
      accPrefixes.join(","));
    const lenAfterTwo = Array.isArray(accumulated) ? accumulated.length : -1;
    await accBundle.handlers.loadLibrary(pathA, 0);
    check("accumulator: re-loading a source does not duplicate it",
      Array.isArray(accumulated) && accumulated.length === lenAfterTwo,
      `len=${Array.isArray(accumulated) ? accumulated.length : "n/a"}`);

    // reset(keep) re-derives the cache from the payload that will be replayed, so a recreated
    // sandbox does not re-clone what its replayed context already holds.
    let repacks = 0;
    const resetBundle = buildLibraryHandler({
      cwd: tmp,
      startIndex: 1,
      onLoaded: () => { repacks++; },
    });
    await resetBundle.handlers.loadLibrary(pathA, 0);
    resetBundle.reset(libraryPrefixesIn(accumulated));
    check("reset(keep): re-seeds the prefix cache", resetBundle.loadedPrefixes().size === 2,
      String(resetBundle.loadedPrefixes().size));
    const afterReset = await resetBundle.handlers.loadLibrary(pathA, 0);
    check("reset(keep): a kept source is alreadyLoaded without re-packing",
      afterReset.alreadyLoaded === true && repacks === 1, `repacks=${repacks}`);
    resetBundle.reset();
    check("reset(): no-arg still clears, as before", resetBundle.loadedPrefixes().size === 0);

    // ── Pre-flight refusals: never commit an index/prefix for an append the worker will reject ──
    let refusedLoads = 0;
    const refuseBundle = buildLibraryHandler({
      cwd: tmp,
      startIndex: 1,
      getContext: () => "plain text",   // what a pre-#4 child had as its whole world
      onLoaded: () => { refusedLoads++; },
    });
    let refusal = "";
    try {
      await refuseBundle.handlers.loadLibrary(pathA, 0);
    } catch (e: unknown) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    check("pre-flight: non-list context is refused with the worker's exact wording",
      refusal === "load_library requires list context (file bundle); got str", refusal);
    check("pre-flight: nothing committed on refusal",
      refusedLoads === 0 && refuseBundle.loadedPrefixes().size === 0);

    const emptyDir = join(tmp, "empty-lib");
    await mkdir(emptyDir, { recursive: true });
    let emptyRefusal = "";
    const emptyBundle = buildLibraryHandler({ cwd: tmp, startIndex: 1, getContext: () => [] });
    try {
      await emptyBundle.handlers.loadLibrary(emptyDir, 0);
    } catch (e: unknown) {
      emptyRefusal = e instanceof Error ? e.message : String(e);
    }
    check("pre-flight: a source that packs to nothing is refused before committing",
      emptyRefusal.includes("produced no files") || emptyRefusal.includes("pack failed"),
      emptyRefusal);
    check("pre-flight: empty source consumed no prefix", emptyBundle.loadedPrefixes().size === 0);

    // ── M2: concurrent pins share one write, and the file is unlinked exactly once ──
    const payload = [{ path: "p.ts", content: "shared", tokens: 1 }];
    const [pinA, pinB] = await Promise.all([pinContext(payload), pinContext(payload)]);
    check("pin: concurrent holders share one file", pinA.path === pinB.path, pinA.path);
    check("pin: content is the serialized payload",
      JSON.parse(await readFile(pinA.path, "utf-8"))[0].content === "shared");
    await pinA.release();
    check("pin: file survives while a holder remains", existsSync(pinB.path));
    await pinB.release();
    check("pin: unlinked once the last holder releases", !existsSync(pinB.path));
    await pinB.release(); // idempotent — must not throw or double-unlink
    check("pin: release is idempotent", pinnedCount() === 0, String(pinnedCount()));

    // Live optional: real https clone
    if (process.env.RLM_TEST_LIVE === "1") {
      const live = await resolveLibrarySource("https://github.com/octocat/Hello-World.git", tmp);
      check(
        "live: shallow clone + pack Hello-World",
        live.ok && Array.isArray(live.value.payload) && live.value.files >= 1
          && hasLibPrefix(live.value.payload[0]?.path, "Hello-World"),
        live.ok ? `files=${live.value.files} path=${live.value.payload[0]?.path}` : live.error,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (failureCount() > 0) {
    console.error(`\n${failureCount()} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll phase-library checks passed.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
