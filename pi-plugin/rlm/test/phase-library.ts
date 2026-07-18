/**
 * load_library() — resolver, worker round-trip, prompt gating, resume sidecars.
 * Run: bun run pi-plugin/rlm/test/phase-library.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failureCount } from "./helpers.ts";
import { resolveLibrarySource } from "../src/context/library-context.ts";
import { PythonSandbox } from "../src/sandbox/sandbox.ts";
import { buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { writeContextSidecar } from "../src/state/writes.ts";
import { readLibrarySidecars } from "../src/state/reads.ts";

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "rlm-lib-test-"));
  try {
    // 1. Resolver: single file
    const f = join(tmp, "doc.md");
    const fileText = "# api\nhello";
    await writeFile(f, fileText);
    const r1 = await resolveLibrarySource(f, tmp);
    check(
      "resolver: single file → string payload",
      r1.ok && typeof r1.value.payload === "string" && r1.value.chars === fileText.length,
      r1.ok ? `chars=${r1.value.chars}` : r1.error,
    );

    // 2. Resolver: directory → packed list[dict]
    await mkdir(join(tmp, "lib/src"), { recursive: true });
    await writeFile(join(tmp, "lib/src/a.ts"), "export const a = 1;");
    const r2 = await resolveLibrarySource(join(tmp, "lib"), tmp);
    check(
      "resolver: directory → packed array",
      r2.ok && Array.isArray(r2.value.payload) && r2.value.files === 1,
      r2.ok ? `files=${r2.value.files} chars=${r2.value.chars}` : r2.error,
    );

    // 3. Resolver: missing path + bad scheme
    const missing = await resolveLibrarySource("./nope", tmp);
    check("resolver: missing path fails", !missing.ok, missing.ok ? "ok unexpectedly" : missing.error);
    const badScheme = await resolveLibrarySource("ftp://x/y", tmp);
    check("resolver: bad URL scheme fails", !badScheme.ok, badScheme.ok ? "ok unexpectedly" : badScheme.error);
    const empty = await resolveLibrarySource("   ", tmp);
    check("resolver: empty source fails", !empty.ok);

    // 4. Worker round-trip with a fake handler
    const sandbox = await PythonSandbox.spawn({
      handlers: {
        loadLibrary: async (source) => ({ payload: `LIB:${source}`, index: 1, chars: 9 }),
      },
    });
    try {
      const res = await sandbox.exec(
        'info = load_library("mylib")\nprint(info["var"], context_1)',
      );
      check(
        "worker: load_library loads context_N",
        res.stdout.includes("context_1 LIB:mylib"),
        res.stdout.trim().slice(0, 120),
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

    // 6. Prompt gating
    const meta = { contextType: "json", contextChars: 100 };
    check(
      "prompt: libraryLoader true includes load_library",
      buildRlmSystemPrompt(meta, { libraryLoader: true }).includes("load_library"),
    );
    check(
      "prompt: libraryLoader false omits load_library",
      !buildRlmSystemPrompt(meta, { libraryLoader: false }).includes("load_library"),
    );

    // 7. Sidecar round-trip
    const cwd = tmp;
    const dir = "runs";
    const runId = "2026-01-01_00-00-00-abcd";
    await writeContextSidecar(cwd, dir, runId, [{ path: "a", content: "x", tokens: 1 }], true, 2);
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

    // Live optional: real https clone
    if (process.env.RLM_TEST_LIVE === "1") {
      const live = await resolveLibrarySource("https://github.com/octocat/Hello-World.git", tmp);
      check(
        "live: shallow clone + pack Hello-World",
        live.ok && Array.isArray(live.value.payload) && (live.value.files ?? 0) >= 1,
        live.ok ? `files=${live.value.files}` : live.error,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
