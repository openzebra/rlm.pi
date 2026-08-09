/**
 * Windows/cp1252 transport encoding (issue #7). Runs on any platform: a hostile locale is
 * forced onto the child's env, which is what Windows hands the worker for free.
 * Run: bun run pi-plugin/rlm/test/phase-encoding.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { check, failureCount } from "./helpers.ts";
import { buildAddContextHandler } from "../src/bridge/add-context.ts";
import { PythonSandbox, type SandboxOptions } from "../src/sandbox/sandbox.ts";
import type { ReplResult } from "../src/sandbox/protocol.ts";

const HOSTILE = Object.freeze({
  LC_ALL: "C", // → open() defaults to ASCII/cp1252 : breaks load_context + add_context
  LANG: "C",
  PYTHONIOENCODING: "cp1252", // → breaks _send / readline, and outranks -X utf8=1
  PYTHONUTF8: "0",
});

// Cyrillic + CJK + emoji + a cp1252-undefined byte in UTF-8 (0x90 appears inside U+0410..).
const SAMPLE = "Привет — 世界 🚀 ok";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(TEST_DIR, "..", "src", "sandbox", "py");
/** Check 6's scanner. A real .py file so it stays lintable and runnable by hand. */
const NO_BARE_OPEN_PY = join(TEST_DIR, "fixtures", "no-bare-open.py");

/** Python length of SAMPLE (code points, not UTF-8 bytes). */
const SAMPLE_LEN = [...SAMPLE].length;

const SANDBOX_DEFAULTS = Object.freeze({
  execTimeoutS: 30,
  requestTimeoutMs: 30_000,
  initTimeoutMs: 30_000,
} satisfies SandboxOptions);

type EnvSnapshot = ReadonlyMap<string, string | undefined>;

function applyHostileEnv(): EnvSnapshot {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(HOSTILE)) {
    prev.set(k, process.env[k]);
    process.env[k] = v;
  }
  return prev;
}

function restoreEnv(prev: EnvSnapshot): void {
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function formatCaught(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240);
}

function formatRes(res: ReplResult, max = 80): string {
  return res.raised ? res.stderr.slice(0, 200) : res.stdout.trim().slice(0, max);
}

/**
 * Spawn → run → dispose. Catches so each check can assert without repeating the
 * nested try/finally scaffold. Spawn defaults stay local (other suites inline them).
 */
async function withSandbox<T>(
  opts: SandboxOptions,
  fn: (sandbox: PythonSandbox) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string }> {
  const sandbox = await PythonSandbox.spawn({ ...SANDBOX_DEFAULTS, ...opts });
  try {
    return { ok: true, value: await fn(sandbox) };
  } catch (e: unknown) {
    return { ok: false, detail: formatCaught(e) };
  } finally {
    await sandbox.dispose();
  }
}

function runPython(args: readonly string[], cwd: string): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("python3", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...HOSTILE },
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out.push(c); });
    child.stderr.on("data", (c: string) => { err.push(c); });
    child.on("error", (e) => {
      resolve({ code: 1, stdout: out.join(""), stderr: `${err.join("")}${e.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

async function main(): Promise<void> {
  const prev = applyHostileEnv();
  const tmp = await mkdtemp(join(tmpdir(), "rlm-enc-test-"));
  try {
    // 1. load_context — host writes UTF-8; worker must decode it under a hostile locale.
    {
      const r = await withSandbox({}, async (sandbox) => {
        await sandbox.loadContext([{ path: "a.rs", content: SAMPLE, tokens: 1 }]);
        const res = await sandbox.exec("print(context[0]['content'])");
        return {
          contentRoundTrip: !res.raised && res.stdout.includes(SAMPLE),
          detail: formatRes(res, 80),
        };
      });
      check(
        "load_context: non-ASCII payload loads under hostile locale",
        r.ok,
        r.ok ? r.value.detail : r.detail,
      );
      check(
        "load_context: content round-trips byte-for-byte",
        r.ok && r.value.contentRoundTrip,
        r.ok ? r.value.detail : r.detail,
      );
    }

    // 2. add_context — second copy of the same bare-open path (worker.py _add_context).
    {
      const libDir = join(tmp, "mylib");
      await mkdir(libDir, { recursive: true });
      await writeFile(join(libDir, "hi.ts"), `// ${SAMPLE}\nexport const x = 1;\n`, "utf8");

      const bundle = buildAddContextHandler({ cwd: tmp });
      const r = await withSandbox({ handlers: bundle.handlers }, async (sandbox) => {
        await sandbox.loadContext([{ path: "repo.ts", content: "root", tokens: 1 }]);
        const res = await sandbox.exec(
          [
            `info = add_context(${JSON.stringify(libDir)})`,
            'print(info["files"], info.get("already_loaded", False))',
            "print(next(c['content'] for c in context if 'hi.ts' in c.get('path','')))",
          ].join("\n"),
        );
        return {
          ok: !res.raised
            && res.stdout.includes(SAMPLE)
            && !res.stdout.trim().startsWith("Error:"),
          detail: formatRes(res, 160),
        };
      });
      check(
        "add_context: non-ASCII file round-trips under hostile locale",
        r.ok && r.value.ok,
        r.ok ? r.value.detail : r.detail,
      );
    }

    // 3. stdout — _send with ensure_ascii=False must not die mid-request on non-ASCII.
    // Build SAMPLE via \u escapes so the request frame is pure ASCII. A broken stdin would
    // otherwise mojibake-decode UTF-8 into latin-1 code units that re-encode to the same
    // bytes and silently "pass". Real Unicode in the worker is what kills cp1252 stdout.
    {
      const r = await withSandbox({}, async (sandbox) => {
        const res = await sandbox.exec(
          "s = '\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442 \\u2014 \\u4e16\\u754c \\U0001f680 ok'; print(s)",
        );
        const alive = await sandbox.exec("print(1+1)");
        const stdoutOk = !res.raised && res.stdout.includes(SAMPLE);
        const aliveOk = !alive.raised && alive.stdout.includes("2");
        return {
          ok: stdoutOk && aliveOk,
          detail: !aliveOk
            ? `worker dead after non-ASCII print: ${alive.stderr.slice(0, 160)}`
            : formatRes(res, 80),
        };
      });
      check(
        "stdout: print(non-ASCII) returns SAMPLE and worker stays up",
        r.ok && r.value.ok,
        r.ok ? r.value.detail : r.detail,
      );
    }

    // 4. stdin — request frame itself carries non-ASCII source; length must survive.
    // Under cp1252 stdin the UTF-8 bytes of SAMPLE become one char each (byte-len 31),
    // so a correct fix is the only way to get Python len == code-point count.
    {
      const r = await withSandbox({}, async (sandbox) => {
        const res = await sandbox.exec(
          `s = ${JSON.stringify(SAMPLE)}; print(len(s)); print(s)`,
        );
        const lines = res.stdout.trim().split("\n");
        return {
          ok: !res.raised
            && lines[0] === String(SAMPLE_LEN)
            && (lines[1] ?? "").includes(SAMPLE),
          detail: res.raised
            ? res.stderr.slice(0, 200)
            : `got len=${lines[0]} body=${(lines[1] ?? "").slice(0, 40)} want len=${SAMPLE_LEN}`,
        };
      });
      check(
        "stdin: non-ASCII source frame round-trips (len+body)",
        r.ok && r.value.ok,
        r.ok ? r.value.detail : r.detail,
      );
    }

    // 5. model-written open() — bare open() must read UTF-8 under a hostile locale.
    // Full-stack coverage is fine; this does NOT isolate -X utf8=1 alone (the assertion
    // also rides stdout). Check 6 is what uniquely proves the -X layer / encoding= net.
    {
      const dataPath = join(tmp, "model-data.txt");
      await writeFile(dataPath, SAMPLE, "utf8");
      const r = await withSandbox({}, async (sandbox) => {
        // Deliberately bare open() — the model-facing surface (guards.py exposes it).
        const res = await sandbox.exec(`print(open(${JSON.stringify(dataPath)}).read())`);
        return {
          ok: !res.raised && res.stdout.includes(SAMPLE),
          detail: formatRes(res, 80),
        };
      });
      check(
        "model open(): bare open() reads UTF-8 under hostile locale",
        r.ok && r.value.ok,
        r.ok ? r.value.detail : r.detail,
      );
    }

    // 6. no bare open() left in the scaffold — EncodingWarning must stay silent on
    //    worker.py / guards.py / hostio.py once every open/io.open carries encoding=.
    //    Load-bearing for hostio.read_host_payload's encoding= (masked under -X utf8=1
    //    at runtime — see hostio docstring). Do not drop this check "as redundant".
    {
      // AST scan (flags bare open/io.open) + runtime EncodingWarning under
      // -X warn_default_encoding when hostio exercises its I/O. EncodingWarning is 3.10+.
      const result = await runPython(
        ["-X", "warn_default_encoding", NO_BARE_OPEN_PY, PY_DIR],
        PY_DIR,
      );
      const ok = result.code === 0 && result.stdout.includes("ok")
        && !result.stderr.includes("EncodingWarning");
      check(
        "scaffold: no bare open/io.open (EncodingWarning silent)",
        ok,
        result.code === 0
          ? result.stdout.trim().slice(0, 120)
          : `${result.stderr.slice(0, 200)} | ${result.stdout.slice(0, 120)}`,
      );
    }

    // 7. surrogatepass on stdout — a lone surrogate must not kill the worker mid-response.
    // Without errors="surrogatepass", json.dumps(ensure_ascii=False) + write raises and
    // the process dies on work it already finished. Content may degrade (Node maps bad
    // bytes to U+FFFD); the contract is raised=false and a live follow-up exec.
    {
      const r = await withSandbox({}, async (sandbox) => {
        const res = await sandbox.exec("s = 'tail' + chr(0xDCFF); print(s); print(len(s))");
        const alive = await sandbox.exec("print(1+1)");
        const aliveOk = !alive.raised && alive.stdout.includes("2");
        // Python len is 5 (four ASCII + one surrogate); frame must parse either way.
        const lenLine = res.stdout.trim().split("\n").find((line) => line === "5");
        return {
          ok: !res.raised && aliveOk && res.stdout.includes("tail") && lenLine !== undefined,
          detail: !aliveOk
            ? `worker dead after lone surrogate: ${alive.stderr.slice(0, 160)}`
            : formatRes(res, 120),
        };
      });
      check(
        "stdout: lone surrogate (surrogatepass) keeps worker alive",
        r.ok && r.value.ok,
        r.ok ? r.value.detail : r.detail,
      );
    }
  } finally {
    restoreEnv(prev);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (failureCount() > 0) {
    console.error(`\n${failureCount()} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll phase-encoding checks passed.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
