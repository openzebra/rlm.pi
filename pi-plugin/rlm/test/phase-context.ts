/**
 * add_context() — resolver, worker round-trip, prompt gating, document conversion, cache.
 * Run: bun run pi-plugin/rlm/test/phase-context.ts
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check, failureCount } from "./helpers.ts";
import {
  contextEntryPath,
  contextNamespace,
  contextPathPrefix,
  contextPrefixesIn,
  contextSourceId,
  isContextFile,
  namespaceContextFiles,
  namespaceContextFilesWithChars,
  payloadPrefix,
} from "../src/context/namespace.ts";
import { filterContextByPaths, mergeIntoContext } from "../src/context/merge.ts";
import { resolveSource } from "../src/context/resolve.ts";
import { MAX_CONTEXT_FILE_BYTES } from "../src/context/types.ts";
import { setAnydocForTest } from "../src/context/anydoc.ts";
import { packDirectory } from "../src/context/source-dir.ts";
import { pinContext, pinnedCount } from "../src/sandbox/context-file.ts";
import { buildAddContextHandler } from "../src/bridge/add-context.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";

/** Match `ctx/<basename>-<8hex>/…` fingerprinted prefixes. */
function hasCtxPrefix(path: string | undefined, basename: string): boolean {
  if (path === undefined) return false;
  return new RegExp(`^ctx/${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{8}/`).test(path);
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "rlm-ctx-test-"));
  try {
    // 1. Resolver: single file → namespaced list[dict]
    const f = join(tmp, "doc.md");
    const fileText = "# api\nhello";
    await writeFile(f, fileText);
    const r1 = await resolveSource(f, { cwd: tmp });
    check(
      "resolver: single file → namespaced list payload",
      r1.ok
        && Array.isArray(r1.value.payload)
        && r1.value.files === 1
        && hasCtxPrefix(r1.value.payload[0]?.path, "doc.md"),
      r1.ok ? `path=${r1.value.payload[0]?.path} chars=${r1.value.chars}` : r1.error,
    );
    check(
      "resolver: chars equals content length (not JSON length)",
      r1.ok && r1.value.chars === fileText.length,
      r1.ok ? `chars=${r1.value.chars} content=${fileText.length}` : "fail",
    );

    // 2. Resolver: directory → packed list[dict] under ctx/<id>/
    await mkdir(join(tmp, "extlib/src"), { recursive: true });
    await writeFile(join(tmp, "extlib/src/a.ts"), "export const a = 1;");
    const r2 = await resolveSource(join(tmp, "extlib"), { cwd: tmp });
    check(
      "resolver: directory → packed namespaced array",
      r2.ok
        && Array.isArray(r2.value.payload)
        && r2.value.files === 1
        && hasCtxPrefix(r2.value.payload[0]?.path, "extlib"),
      r2.ok ? `files=${r2.value.files} path=${r2.value.payload[0]?.path}` : r2.error,
    );

    // 3. Resolver: missing path + bad scheme
    const missing = await resolveSource("./nope", { cwd: tmp });
    check("resolver: missing path fails", !missing.ok, missing.ok ? "ok unexpectedly" : missing.error);
    const badScheme = await resolveSource("ftp://x/y", { cwd: tmp });
    check("resolver: bad URL scheme fails", !badScheme.ok, badScheme.ok ? "ok unexpectedly" : badScheme.error);
    const empty = await resolveSource("   ", { cwd: tmp });
    check("resolver: empty source fails", !empty.ok);

    // 3b. Namespace + merge helpers
    const namespaced = namespaceContextFiles([{ path: "a.ts", content: "x", tokens: 1 }], "mylib");
    check(
      "namespaceContextFiles prefixes paths",
      namespaced.length === 1 && namespaced[0]?.path === "ctx/mylib/a.ts",
      namespaced[0]?.path ?? "empty",
    );
    const merged = mergeIntoContext(
      [{ path: "repo.ts", content: "r", tokens: 1 }],
      namespaced,
    );
    check(
      "mergeIntoContext concatenates lists",
      Array.isArray(merged) && merged.length === 2,
      Array.isArray(merged) ? `len=${merged.length}` : "not array",
    );
    const sid = contextSourceId("/Users/x/bearby-core", "/Users/x/bearby-core");
    check(
      "contextSourceId fingerprinted basename",
      /^bearby-core-[0-9a-f]{8}$/.test(sid),
      sid,
    );
    const ns = contextNamespace(f, tmp);
    check(
      "contextNamespace returns matching id+prefix",
      ns.pathPrefix === `ctx/${ns.sourceId}/` && hasCtxPrefix(`${ns.pathPrefix}x`, "doc.md"),
      `${ns.sourceId} ${ns.pathPrefix}`,
    );

    // 3c. Basename collision resistance
    await mkdir(join(tmp, "proj-a", "utils"), { recursive: true });
    await mkdir(join(tmp, "proj-b", "utils"), { recursive: true });
    await writeFile(join(tmp, "proj-a", "utils", "a.ts"), "export const a = 1;");
    await writeFile(join(tmp, "proj-b", "utils", "b.ts"), "export const b = 2;");
    const pathA = join(tmp, "proj-a", "utils");
    const pathB = join(tmp, "proj-b", "utils");
    const prefA = contextPathPrefix(pathA, tmp);
    const prefB = contextPathPrefix(pathB, tmp);
    check(
      "collision: same basename → distinct prefixes",
      prefA !== prefB,
      `${prefA} vs ${prefB}`,
    );
    check(
      "collision: same source → stable prefix",
      contextPathPrefix(pathA, tmp) === prefA,
    );

    // 4. Worker round-trip: append into context
    const sandbox = await PythonSandbox.spawn({
      handlers: {
        addContext: async (source) => ({
          payload: [{ path: `ctx/${source}/hi.ts`, content: `LIB:${source}`, tokens: 2 }],
          index: 1,
          files: 1,
          chars: 20,
          sourceId: source,
          pathPrefix: `ctx/${source}/`,
          converted: 0,
          skipped: [],
        }),
      },
    });
    try {
      await sandbox.loadContext([{ path: "repo.ts", content: "root", tokens: 1 }]);
      const res = await sandbox.exec(
        [
          'info = add_context("mylib")',
          'print(info["source_id"], info["path_prefix"], info["files"], info["context_len"])',
          'print(len(context), context[0]["path"], context[1]["path"], context[1]["content"])',
        ].join("\n"),
      );
      check(
        "worker: add_context appends into single context",
        res.stdout.includes("mylib")
          && res.stdout.includes("ctx/mylib/")
          && res.stdout.includes("2 repo.ts")
          && res.stdout.includes("ctx/mylib/hi.ts")
          && res.stdout.includes("LIB:mylib"),
        res.stdout.trim().slice(0, 200),
      );

      const resIdem = await sandbox.exec(
        'info2 = add_context("mylib")\nprint(info2["already_loaded"], info2["files"], len(context))',
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
      const res2 = await bare.exec('print(add_context("x"))');
      check(
        "worker: REJECT add_context → Error string",
        res2.stdout.trim().startsWith("Error:") && !res2.raised,
        res2.stdout.trim().slice(0, 80),
      );
    } finally {
      await bare.dispose();
    }

    // 5b. Non-list context rejected
    const textCtx = await PythonSandbox.spawn({
      handlers: {
        addContext: async () => ({
          payload: [{ path: "ctx/x/a", content: "a", tokens: 1 }],
          index: 1,
          files: 1,
          chars: 1,
          sourceId: "x",
          pathPrefix: "ctx/x/",
        }),
      },
    });
    try {
      await textCtx.loadContext("plain text context");
      const resText = await textCtx.exec('print(add_context("x"))');
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
    const withCtx = buildRlmSystemPrompt(meta, { contextLoader: true });
    check(
      "prompt: contextLoader true includes add_context",
      withCtx.includes("add_context"),
    );
    check(
      "prompt: contextLoader documents append into context",
      withCtx.includes("APPEND") || withCtx.includes("append"),
      withCtx.includes("add_context") ? "has add_context" : "missing",
    );
    check(
      "prompt: contextLoader false omits add_context",
      !buildRlmSystemPrompt(meta, { contextLoader: false }).includes("add_context"),
    );

    // 7. Git clone error path
    const gitFail = await resolveSource("https://127.0.0.1:1/not-a-repo.git", { cwd: tmp });
    check(
      "resolver: git clone failure returns error",
      !gitFail.ok && gitFail.error.includes("git clone failed"),
      gitFail.ok ? "ok unexpectedly" : gitFail.error.slice(0, 120),
    );

    // 9. Host-side idempotency
    let onLoadedCalls = 0;
    const bundle = buildAddContextHandler({
      cwd: tmp,
      onLoaded: async () => { onLoadedCalls++; },
    });
    const first = await bundle.handlers.addContext(f, 0);
    const second = await bundle.handlers.addContext(f, 0);
    check("host: first load packs", first.alreadyLoaded !== true && first.files === 1);
    check("host: second load is alreadyLoaded", second.alreadyLoaded === true && second.files === 0);
    check("host: onLoaded called once", onLoadedCalls === 1, String(onLoadedCalls));
    check("host: loadedPrefixes has one entry", bundle.loadedPrefixes().size === 1);

    // 9b. Distinct basenames must both load
    let collisionLoads = 0;
    const collisionBundle = buildAddContextHandler({
      cwd: tmp,
      onLoaded: async () => { collisionLoads++; },
    });
    const loadA = await collisionBundle.handlers.addContext(pathA, 0);
    const loadB = await collisionBundle.handlers.addContext(pathB, 0);
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
    const sideA = namespaceContextFiles([{ path: "a.ts", content: "x", tokens: 1 }], "mylib");
    const base = [{ path: "repo.ts", content: "r", tokens: 1 }];
    const once = mergeIntoContext(base, sideA);
    const twice = mergeIntoContext(once, sideA);
    check(
      "merge: duplicate source sidecar does not double paths",
      Array.isArray(twice) && twice.length === 2,
      Array.isArray(twice) ? `len=${twice.length}` : "not array",
    );

    // 9c. Merge dedup from non-first entry
    const mixedPayload = [
      { path: "not-namespaced.ts", content: "z", tokens: 1 },
      { path: "ctx/mylib/a.ts", content: "x", tokens: 1 },
    ];
    check(
      "payloadPrefix: finds prefix after non-namespaced head",
      payloadPrefix(mixedPayload) === "ctx/mylib/",
      String(payloadPrefix(mixedPayload)),
    );
    const afterMixed = mergeIntoContext(
      [{ path: "repo.ts", content: "r", tokens: 1 }, { path: "ctx/mylib/old.ts", content: "o", tokens: 1 }],
      mixedPayload,
    );
    check(
      "merge: dedups when first entry lacks ctx/ prefix",
      Array.isArray(afterMixed) && afterMixed.length === 2,
      Array.isArray(afterMixed) ? `len=${afterMixed.length}` : "not array",
    );

    // Two distinct ctx/unknown/ payloads both merge
    const unk1 = namespaceContextFiles("legacy-a", "unknown");
    const unk2 = namespaceContextFiles("legacy-b", "unknown");
    check("payloadPrefix: ctx/unknown/ ignored", payloadPrefix(unk1) === undefined);
    const withUnk = mergeIntoContext([{ path: "repo.ts", content: "r", tokens: 1 }], unk1);
    const withBothUnk = mergeIntoContext(withUnk, unk2);
    check(
      "merge: two ctx/unknown/ payloads both merge",
      Array.isArray(withBothUnk) && withBothUnk.length === 3,
      Array.isArray(withBothUnk) ? `len=${withBothUnk.length}` : "not array",
    );

    // 10. Oversize single-file rejected with llm_query_chunked guidance
    const huge = join(tmp, "huge.bin");
    await writeFile(huge, Buffer.alloc(MAX_CONTEXT_FILE_BYTES + 1, 0x61));
    const over = await resolveSource(huge, { cwd: tmp });
    check(
      "resolver: oversize file fails with chunked guidance",
      !over.ok
        && over.error.includes("llm_query_chunked")
        && over.error.includes("limit"),
      over.ok ? "ok unexpectedly" : over.error.slice(0, 160),
    );

    // chars unit
    const wc = namespaceContextFilesWithChars(
      [{ path: "a", content: "hi", tokens: 1 }, { path: "b", content: "there", tokens: 1 }],
      "t",
    );
    check("withChars: sum of content lengths", wc.chars === 7, String(wc.chars));

    // ── primitives ──
    check("isContextFile: accepts a file entry",
      isContextFile({ path: "a.ts", content: "x", tokens: 1 }));
    check("isContextFile: rejects non-file shapes",
      !isContextFile(null) && !isContextFile("a.ts") && !isContextFile({ path: 1, content: "x" }));
    check("contextEntryPath: reads a path, undefined otherwise",
      contextEntryPath({ path: "a.ts", content: "x" }) === "a.ts"
        && contextEntryPath(42) === undefined);

    check("contextPrefixesIn: empty for a non-array", contextPrefixesIn("plain text").length === 0);
    const twoLibs = [
      { path: "repo.ts", content: "r", tokens: 1 },
      { path: "ctx/one-11111111/a.ts", content: "x", tokens: 1 },
      { path: "ctx/two-22222222/b.ts", content: "y", tokens: 1 },
      { path: "ctx/one-11111111/c.ts", content: "z", tokens: 1 },
      { path: "ctx/unknown/legacy.ts", content: "w", tokens: 1 },
    ];
    const prefixes = contextPrefixesIn(twoLibs);
    check("contextPrefixesIn: distinct prefixes, ctx/unknown/ skipped",
      prefixes.length === 2 && prefixes.includes("ctx/one-11111111/")
        && prefixes.includes("ctx/two-22222222/"),
      prefixes.join(","));

    const filteredOne = filterContextByPaths(twoLibs, ["ctx/one-11111111/"]);
    check("filterContextByPaths: prefix selects its subtree",
      filteredOne.files.length === 2 && filteredOne.unmatched.length === 0,
      `${filteredOne.files.length} file(s)`);
    const filteredMixed = filterContextByPaths(twoLibs, ["ctx/two-22222222/", "nope/"]);
    check("filterContextByPaths: reports prefixes that matched nothing",
      filteredMixed.files.length === 1 && filteredMixed.unmatched.length === 1
        && filteredMixed.unmatched[0] === "nope/",
      filteredMixed.unmatched.join(","));
    check("filterContextByPaths: non-array yields no files, all unmatched",
      filterContextByPaths("text", ["a/"]).files.length === 0
        && filterContextByPaths("text", ["a/"]).unmatched.length === 1);
    check("filterContextByPaths: no prefixes selects nothing",
      filterContextByPaths(twoLibs, []).files.length === 0);

    // ── Accumulator ──
    let accumulated: unknown = [{ path: "repo.ts", content: "r", tokens: 1 }];
    const accBundle = buildAddContextHandler({
      cwd: tmp,
      getContext: () => accumulated,
      onLoaded: (payload) => { accumulated = mergeIntoContext(accumulated, payload); },
    });
    await accBundle.handlers.addContext(pathA, 0);
    await accBundle.handlers.addContext(pathB, 0);
    const accPrefixes = contextPrefixesIn(accumulated);
    check("accumulator: both sources present after two loads", accPrefixes.length === 2,
      accPrefixes.join(","));
    const lenAfterTwo = Array.isArray(accumulated) ? accumulated.length : -1;
    await accBundle.handlers.addContext(pathA, 0);
    check("accumulator: re-loading a source does not duplicate it",
      Array.isArray(accumulated) && accumulated.length === lenAfterTwo,
      `len=${Array.isArray(accumulated) ? accumulated.length : "n/a"}`);

    // reset(keep)
    let repacks = 0;
    const resetBundle = buildAddContextHandler({
      cwd: tmp,
      onLoaded: () => { repacks++; },
    });
    await resetBundle.handlers.addContext(pathA, 0);
    resetBundle.reset(contextPrefixesIn(accumulated));
    check("reset(keep): re-seeds the prefix cache", resetBundle.loadedPrefixes().size === 2,
      String(resetBundle.loadedPrefixes().size));
    const afterReset = await resetBundle.handlers.addContext(pathA, 0);
    check("reset(keep): a kept source is alreadyLoaded without re-packing",
      afterReset.alreadyLoaded === true && repacks === 1, `repacks=${repacks}`);
    resetBundle.reset();
    check("reset(): no-arg still clears, as before", resetBundle.loadedPrefixes().size === 0);

    // ── Pre-flight refusals ──
    let refusedLoads = 0;
    const refuseBundle = buildAddContextHandler({
      cwd: tmp,
      getContext: () => "plain text",
      onLoaded: () => { refusedLoads++; },
    });
    let refusal = "";
    try {
      await refuseBundle.handlers.addContext(pathA, 0);
    } catch (e: unknown) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    check("pre-flight: non-list context is refused with the worker's exact wording",
      refusal === "add_context requires list context (file bundle); got str", refusal);
    check("pre-flight: nothing committed on refusal",
      refusedLoads === 0 && refuseBundle.loadedPrefixes().size === 0);

    const emptyDir = join(tmp, "empty-lib");
    await mkdir(emptyDir, { recursive: true });
    let emptyRefusal = "";
    const emptyBundle = buildAddContextHandler({ cwd: tmp, getContext: () => [] });
    try {
      await emptyBundle.handlers.addContext(emptyDir, 0);
    } catch (e: unknown) {
      emptyRefusal = e instanceof Error ? e.message : String(e);
    }
    check("pre-flight: a source that packs to nothing is refused before committing",
      emptyRefusal.includes("produced no files") || emptyRefusal.includes("pack failed"),
      emptyRefusal);
    check("pre-flight: empty source consumed no prefix", emptyBundle.loadedPrefixes().size === 0);

    // ── pinContext ──
    const payload = [{ path: "p.ts", content: "shared", tokens: 1 }];
    const [pinA, pinB] = await Promise.all([pinContext(payload), pinContext(payload)]);
    check("pin: concurrent holders share one file", pinA.path === pinB.path, pinA.path);
    check("pin: content is the serialized payload",
      JSON.parse(await readFile(pinA.path, "utf-8"))[0].content === "shared");
    await pinA.release();
    check("pin: file survives while a holder remains", existsSync(pinB.path));
    await pinB.release();
    check("pin: unlinked once the last holder releases", !existsSync(pinB.path));
    await pinB.release();
    check("pin: release is idempotent", pinnedCount() === 0, String(pinnedCount()));

    // ── NEW: .csv → Markdown table ──
    const csvPath = join(tmp, "data.csv");
    await writeFile(csvPath, "a,b\n1,2\n");
    const csvRes = await resolveSource(csvPath, { cwd: tmp });
    check(
      "csv: converts to Markdown table",
      csvRes.ok
        && csvRes.value.converted === 1
        && csvRes.value.payload[0]?.content.includes("| a | b |")
        && csvRes.value.payload[0]?.content.includes("| 1 | 2 |"),
      csvRes.ok ? csvRes.value.payload[0]?.content.slice(0, 80) : csvRes.error,
    );

    // ── NEW: NUL-byte binary → skipped ──
    const binDir = join(tmp, "bindir");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "plain.ts"), "export const x = 1;\n");
    await writeFile(join(binDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const binPack = await packDirectory(binDir, "ctx/bindir-test/");
    check(
      "binary: plain text present",
      binPack.files.some((f) => f.path.endsWith("plain.ts")),
      binPack.files.map((f) => f.path).join(","),
    );
    check(
      "binary: NUL file skipped as binary",
      !binPack.files.some((f) => f.path.endsWith("blob.bin"))
        && binPack.skipped.some((s) => s.reason === "binary"),
      binPack.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
    );

    // ── NEW: empty-prefix / cwd seed wiring (not just the sentinel by hand) ──
    const seedBundle = buildAddContextHandler({
      cwd: tmp,
      onLoaded: () => { /* host grows context */ },
    });
    // Simulate what index.ts seedContext does after resolveSource(cwd, pathPrefix:"").
    seedBundle.markSeededCwd(tmp);
    check("cwd-seed: markSeededCwd plants \"\" sentinel", seedBundle.loadedPrefixes().has(""));
    check("cwd-seed: seededCwd records abs path", seedBundle.seededCwd() === tmp
      || seedBundle.seededCwd() === resolve(tmp),
      String(seedBundle.seededCwd()));
    const reAddCwd = await seedBundle.handlers.addContext(".", 0);
    check(
      "cwd-seed: add_context(\".\") is alreadyLoaded (no 2× pack)",
      reAddCwd.alreadyLoaded === true && reAddCwd.files === 0 && reAddCwd.pathPrefix === "",
      `already=${String(reAddCwd.alreadyLoaded)} files=${reAddCwd.files} prefix=${reAddCwd.pathPrefix}`,
    );
    const reAddAbs = await seedBundle.handlers.addContext(tmp, 0);
    check(
      "cwd-seed: add_context(abs cwd) is alreadyLoaded",
      reAddAbs.alreadyLoaded === true && reAddAbs.files === 0,
      `already=${String(reAddAbs.alreadyLoaded)} files=${reAddAbs.files}`,
    );
    // Un-prefixed payloads never look like ctx/<id>/ so merge path-scan must still append.
    const emptyPrefPayload = [{ path: "src/a.ts", content: "x", tokens: 1 }];
    const afterEmptyMerge = mergeIntoContext(
      [{ path: "repo.ts", content: "r", tokens: 1 }],
      emptyPrefPayload,
    );
    check(
      "cwd-seed: merge path-scan does not false-positive on un-prefixed files",
      Array.isArray(afterEmptyMerge) && afterEmptyMerge.length === 2,
      Array.isArray(afterEmptyMerge) ? `len=${afterEmptyMerge.length}` : "not array",
    );

    // ── NEW: sensitive deny-list (.env, keys) ──
    const sensDir = join(tmp, "sens");
    await mkdir(sensDir, { recursive: true });
    await writeFile(join(sensDir, "app.ts"), "export const ok = 1;\n");
    await writeFile(join(sensDir, ".env"), "OPENAI_API_KEY=sk-live-DEADBEEF\n");
    await writeFile(join(sensDir, "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----\nfake\n");
    await writeFile(join(sensDir, "cert.pem"), "-----BEGIN CERTIFICATE-----\nfake\n");
    const sensPack = await packDirectory(sensDir, "ctx/sens/");
    check(
      "sensitive: app.ts still packed",
      sensPack.files.some((f) => f.path.endsWith("app.ts")),
      sensPack.files.map((f) => f.path).join(","),
    );
    check(
      "sensitive: .env skipped, not in payload",
      !sensPack.files.some((f) => f.path.includes(".env"))
        && sensPack.skipped.some((s) => s.reason === "sensitive" && s.path.includes(".env")),
      sensPack.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
    );
    check(
      "sensitive: id_rsa skipped",
      !sensPack.files.some((f) => f.path.includes("id_rsa"))
        && sensPack.skipped.some((s) => s.reason === "sensitive" && s.path.includes("id_rsa")),
      sensPack.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
    );
    check(
      "sensitive: .pem skipped",
      !sensPack.files.some((f) => f.path.endsWith(".pem"))
        && sensPack.skipped.some((s) => s.reason === "sensitive" && s.path.endsWith(".pem")),
      sensPack.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
    );
    // Single-file add_context of a secret must refuse (hard error, not silent skip).
    const envRefuse = await resolveSource(join(sensDir, ".env"), { cwd: tmp });
    check(
      "sensitive: resolveSource refuses single-file .env",
      !envRefuse.ok && envRefuse.error.includes("sensitive"),
      envRefuse.ok ? "ok unexpectedly" : envRefuse.error.slice(0, 120),
    );

    // ── NEW: anydoc null → documents skipped as no-converter ──
    setAnydocForTest(null);
    const docDir = join(tmp, "docdir");
    await mkdir(docDir, { recursive: true });
    await writeFile(join(docDir, "note.csv"), "x,y\n3,4\n");
    await writeFile(join(docDir, "code.ts"), "export const z = 1;\n");
    const noConv = await packDirectory(docDir, "ctx/noconv/");
    check(
      "no-converter: text file still packed",
      noConv.files.some((f) => f.path.endsWith("code.ts")),
      noConv.files.map((f) => f.path).join(","),
    );
    check(
      "no-converter: document skipped",
      noConv.skipped.some((s) => s.reason === "no-converter" && s.path.endsWith("note.csv")),
      noConv.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
    );
    setAnydocForTest(undefined); // restore real anydoc

    // ── NEW: cache hit / mtime invalidation / no stale-forever ──
    const cacheCsv = join(tmp, "cache-me.csv");
    await writeFile(cacheCsv, "col1,col2\n9,8\n");
    const c1 = await resolveSource(cacheCsv, { cwd: tmp });
    check("cache: first convert succeeds", c1.ok && c1.value.converted === 1,
      c1.ok ? `converted=${c1.value.converted}` : c1.error);
    const body1 = c1.ok ? c1.value.payload[0]?.content : "";
    const c2 = await resolveSource(cacheCsv, { cwd: tmp });
    check("cache: second convert is a hit (converted=0)",
      c2.ok && c2.value.converted === 0 && c2.value.payload[0]?.content === body1,
      c2.ok ? `converted=${c2.value.converted}` : c2.error);
    // Content change + mtime bump: must return NEW markdown, not the old cached body.
    await writeFile(cacheCsv, "col1,col2\n999,999\n");
    const st = await stat(cacheCsv);
    await utimes(cacheCsv, st.atime, new Date(st.mtimeMs + 5_000));
    const c3 = await resolveSource(cacheCsv, { cwd: tmp });
    check("cache: content+mtime change reconverts (not stale forever)",
      c3.ok
        && (c3.value.payload[0]?.content.includes("| 999 | 999 |") ?? false)
        && !(c3.value.payload[0]?.content.includes("| 9 | 8 |") ?? true),
      c3.ok ? c3.value.payload[0]?.content.slice(0, 80) : c3.error);

    // ── NEW: empty listing does NOT provoke add_context(".") ──
    const { formatContextListing } = await import("../src/context/listing.ts");
    const emptyListing = formatContextListing([]);
    check("listing: empty does not suggest add_context(\".\")",
      !emptyListing.includes('add_context(".")') && emptyListing.includes("EMPTY"));

    // ── NEW: symlink → secret outside root is refused (symlink-escape) ──
    const linkDir = join(tmp, "linktree");
    await mkdir(linkDir, { recursive: true });
    await writeFile(join(linkDir, "app.ts"), "export const ok = 1;\n");
    const secretOutside = join(tmp, "outside-secret.env");
    await writeFile(secretOutside, "AWS_SECRET_ACCESS_KEY=REAL_SECRET_HERE\n");
    const notesLink = join(linkDir, "notes.txt");
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(secretOutside, notesLink);
      const linkPack = await packDirectory(linkDir, "ctx/link/");
      check(
        "symlink-escape: innocuous link name does not pack target content",
        !linkPack.files.some((f) => f.content.includes("AWS_SECRET_ACCESS_KEY")),
        linkPack.files.map((f) => f.path).join(","),
      );
      check(
        "symlink-escape: reported as skipped",
        linkPack.skipped.some((s) =>
          (s.reason === "symlink-escape" || s.reason === "sensitive")
          && s.path.includes("notes.txt")),
        linkPack.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
      );
      check(
        "symlink-escape: app.ts still packed",
        linkPack.files.some((f) => f.path.endsWith("app.ts")),
      );
    } catch (e: unknown) {
      // Windows without symlink privilege — skip with a note, don't fail the suite.
      check("symlink-escape: skipped (platform cannot create symlink)", true,
        e instanceof Error ? e.message : String(e));
    }

    // ── NEW: subpath of seeded cwd short-circuits when already in context ──
    const subTree = join(tmp, "seeded-proj");
    await mkdir(join(subTree, "src", "context"), { recursive: true });
    await writeFile(join(subTree, "src", "context", "a.ts"), "export const a = 1;\n");
    await writeFile(join(subTree, "src", "context", "b.ts"), "export const b = 2;\n");
    await writeFile(join(subTree, "app.ts"), "export const app = 1;\n");
    // Seed cwd: un-prefixed pack of whole tree
    const seedRes = await resolveSource(subTree, { cwd: subTree, pathPrefix: "" });
    check("subpath: seed packs files", seedRes.ok && seedRes.value.files >= 3,
      seedRes.ok ? `files=${seedRes.value.files}` : seedRes.error);
    let subAccum: unknown = seedRes.ok ? seedRes.value.payload : [];
    const subBundle = buildAddContextHandler({
      cwd: subTree,
      getContext: () => subAccum,
      onLoaded: (p) => { subAccum = mergeIntoContext(subAccum, p); },
    });
    subBundle.markSeededCwd(subTree);
    const subAdd = await subBundle.handlers.addContext("./src/context", 0);
    check(
      "subpath: add_context(./src/context) is alreadyLoaded when seed holds those files",
      subAdd.alreadyLoaded === true && subAdd.files === 0,
      `already=${String(subAdd.alreadyLoaded)} files=${subAdd.files}`,
    );
    const lenAfterSub = Array.isArray(subAccum) ? subAccum.length : -1;
    check(
      "subpath: context length unchanged (no byte-identical duplicates)",
      seedRes.ok && lenAfterSub === seedRes.value.files,
      `seed=${seedRes.ok ? seedRes.value.files : "?"} after=${lenAfterSub}`,
    );
    // Gitignored-style absent subtree: empty dir not in seed → still packs (or produces no files).
    await mkdir(join(subTree, "node_modules", "foo"), { recursive: true });
    await writeFile(join(subTree, "node_modules", "foo", "index.js"), "module.exports = 1;\n");
    // walkFs ignores node_modules; git would too if gitignored. Force resolve of that path:
    // if seed didn't include it, short-circuit must NOT fire (contextHasUnprefixedUnder false).
    const nmAdd = await subBundle.handlers.addContext("./node_modules/foo", 0);
    // Either packs something (alreadyLoaded false) or produces no files (error) — not a silent
    // alreadyLoaded that pretends the seed had it.
    check(
      "subpath: absent subtree is not false-alreadyLoaded",
      nmAdd.alreadyLoaded !== true || nmAdd.files > 0,
      `already=${String(nmAdd.alreadyLoaded)} files=${nmAdd.files}`,
    );

    // ── NEW: documents count present even on cache hit ──
    const docCsv = join(tmp, "docs-count.csv");
    await writeFile(docCsv, "x,y\n1,2\n");
    const d1 = await resolveSource(docCsv, { cwd: tmp });
    check("documents: first call has documents=1 and converted=1",
      d1.ok && d1.value.documents === 1 && d1.value.converted === 1,
      d1.ok ? `docs=${d1.value.documents} conv=${d1.value.converted}` : d1.error);
    const d2 = await resolveSource(docCsv, { cwd: tmp });
    check("documents: cache hit still reports documents=1 with converted=0",
      d2.ok && d2.value.documents === 1 && d2.value.converted === 0,
      d2.ok ? `docs=${d2.value.documents} conv=${d2.value.converted}` : d2.error);

    // ── NEW: failed-seed recovery packs un-prefixed ──
    const recoverBundle = buildAddContextHandler({ cwd: tmp, getContext: () => [] });
    // No markSeededCwd — simulates sticky failed seed.
    const recover = await recoverBundle.handlers.addContext(".", 0);
    check(
      "recovery: add_context(\".\") without prior seed packs with pathPrefix \"\"",
      recover.alreadyLoaded !== true
        && recover.pathPrefix === ""
        && recover.files > 0
        && recover.payload.every((f) => !f.path.startsWith("ctx/")),
      `already=${String(recover.alreadyLoaded)} prefix=${recover.pathPrefix} files=${recover.files}`,
    );
    check("recovery: marks cwd seeded afterwards",
      recoverBundle.seededCwd() !== undefined);

    // Live optional: real https clone
    if (process.env.RLM_TEST_LIVE === "1") {
      const live = await resolveSource("https://github.com/octocat/Hello-World.git", { cwd: tmp });
      check(
        "live: shallow clone + pack Hello-World",
        live.ok && Array.isArray(live.value.payload) && live.value.files >= 1
          && hasCtxPrefix(live.value.payload[0]?.path, "Hello-World"),
        live.ok ? `files=${live.value.files} path=${live.value.payload[0]?.path}` : live.error,
      );
    }
  } finally {
    setAnydocForTest(undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (failureCount() > 0) {
    console.error(`\n${failureCount()} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll phase-context checks passed.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
