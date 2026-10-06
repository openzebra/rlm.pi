/**
 * The REPL vocabulary both prompts are built from.
 *
 * Headless (fenced ```repl``` blocks) and native (`repl({code})`) describe the same sandbox, so
 * every line either lives here once or has an explicit condensed native twin next to it — that
 * pairing is the whole reason this module exists. Divergence here is a bug: the model is told
 * about functions that do not exist, or not told about ones that do.
 */

import { ARCHIVE_NAMESPACE } from "../core/session-archive.ts";
import { isRecord } from "../util/type-guards.ts";

export type ContextKind = "files" | "text";

/** "str" (raw string context, e.g. rlm_query children) → text; everything else → files. */
export function contextKindOf(contextType: string): ContextKind {
  return contextType === "str" ? "text" : "files";
}

export const DEFAULT_PROMPT_CAP = 400_000;

export function promptCapTokensK(maxPromptChars: number): number {
  return Math.round(maxPromptChars / 4_000);
}

/**
 * Deterministic retrieval over `context` (headless + native).
 *
 * The paper's trajectories retrieve with hand-written regex (App. E.1); frontier models do that
 * well, small ones guess keywords badly, and the first decomposition disproportionately decides
 * the outcome (§5, Fig. 4a). These cost no tokens and no sub-calls.
 */
const RETRIEVAL_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `search(query: str, k=10, path_glob=None)`: BM25 ranking over `context` (stemmed, with",
  "  query expansion — try plain words, not just exact identifiers). Returns",
  "  [{path, line, end, score, snippet, text}] — POINTERS, not bodies (`text` aliases",
  "  `snippet`; line..end is the match span; `index_truncated: true` means the context tail",
  "  is NOT indexed — narrow with path_glob). **Start here.** Free: no sub-LLM call.",
  "- `grep_context(pattern, k=50, path_glob=None, before=0, after=0) -> dict`: regex over",
  "  `context`. Returns {hits: [{path, line, text, snippet}], counts, total, truncated} —",
  "  `counts` is complete even when `hits` is capped, so a wide pattern reports its shape",
  "  instead of flooding you. Use for exact lexical needles; use `search` for meaning.",
  "- `outline(path) -> str`: definition/heading skeleton of one file with line numbers.",
  "  Orient in ~200 chars instead of printing 20K. Matches exact path, then suffix, then glob.",
]);

/** v5 delegation doctrine (audit C5): children have NO retrieval tools — their world is the
 *  sliced `context` they were handed. This REPLACES the retrieval lines in child prompts so
 *  the prompt and the runtime sandbox agree (a child taught to `search` burns turns on NameError). */
const DELEGATION_SURFACE_LINES: readonly string[] = Object.freeze([
  "- **No `search` / `grep_context` / `outline` / `add_context` in this REPL** (delegation",
  "  surface, v5 doctrine): your task arrived WITH its world in `context`. Explore it with",
  "  Python (list comprehensions, string matching, slicing) and delegate slices to sub-LLMs —",
  "  never re-ask the parent for retrieval.",
]);

/** Workstream E: the one new sandbox function (prime-agent rule — surface grows by one). */
const SKILL_SEARCH_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `skill_search(query, k=8) -> [{id, text, tags, score}]`: BM25 over distilled project facts",
  "  from PRIOR sessions (SkillState). Free: no sub-LLM call. Use when a config/gotcha/symbol",
  "  smells like something already learned — do not re-discover it.",
]);

/** W3 recall discoverability: the condensed NATIVE twins. glossary doctrine — divergence
 *  between the headless and native surfaces is a bug; `skill_search` had no native twin, so
 *  native models could not discover cross-session recall at all (and the archive line
 *  teaches the ctx/session-log recall that honest elision stubs point at). */
export const SKILL_SEARCH_LINE_NATIVE =
  "- `skill_search(query, k=8) -> [{id, text, tags, score}]` — BM25 over distilled project facts from PRIOR sessions. Free; use before re-discovering a learned config/gotcha/symbol.";
export const ARCHIVE_RECALL_LINE_NATIVE =
  `- Elided chat turns are archived in the sandbox: \`search("<keywords>", path_glob="${ARCHIVE_NAMESPACE}*")\` / \`grep_context()\` recall text that scrolled out of your context — free, no sub-LLM call.`;

/** Single source of wording for the injected SkillState block (headless + native, Workstream C).
 *  Takes the dynamic body as an argument — the glossary itself stays static-only. */
/** One wording source for the skill_search recall hint (Ξ block + root Σ snapshot). */
export const SKILL_RECALL_LINE =
  "Recall more anytime inside repl: `skill_search(query, k=8)` → [{id, text, tags, score}].";

/** R5 (G4, /tmp/ROOT_FULL_SKILLSTATE_PLAN.md): the one-line replacement for assistant prose
 *  older than the keep window — durable facts live in Σ; the repl sandbox (answers/vars) is
 *  the model-reachable recovery channel for repl-owned payloads. Stubs must promise only a
 *  channel that actually holds the bytes (recall W1): repl-owned payloads → the repl line,
 *  native payloads → the archive line (searchable `ctx/session-log/`), else the plain line. */
export const ROOT_TURN_ELIDED_LINE =
  "… turn elided — durable facts live in Σ; your repl sandbox persists: print(answers) / SHOW_VARS() to re-derive";
export const ROOT_TURN_ELIDED_ARCHIVE_LINE =
  `… turn elided — durable facts live in Σ; the full text is archived in the sandbox: ` +
  `search('<keywords>', path_glob='${ARCHIVE_NAMESPACE}*') or grep_context() recalls it`;
export const ROOT_TURN_ELIDED_PLAIN_LINE =
  "… turn elided — durable facts live in Σ";
/** Preview mark twin: payloads kept as head+tail previews point at the same archive. */
export const ROOT_ELIDE_PREVIEW_MARK =
  `chars elided — full text archived under ${ARCHIVE_NAMESPACE} (search/grep_context it)`;
export const ROOT_ELIDE_PREVIEW_MARK_REPL =
  "chars elided — repl sandbox persists: print(answers[k]) or re-run repl to re-derive";

export function skillStateLines(noteCount: number, body: string): string {
  return [
    `[Project facts — SkillState, ${noteCount} note${noteCount === 1 ? "" : "s"}, distilled from prior sessions]`,
    body,
    SKILL_RECALL_LINE,
  ].join("\n");
}

/** Root Σ WS-2 digest wording — the single source for the header and section labels. */
export const ROOT_DIGEST_HEADER =
  "[Root digest — deterministic structural compaction (no model call). Older turns are " +
  "superseded by this digest plus the verbatim tail that follows; fresh tool results " +
  "outrank the digest when they disagree.]";
export const ROOT_DIGEST_SECTIONS: Readonly<Record<"task" | "findings" | "state" | "next" | "facts", string>> =
  Object.freeze({ task: "Task", findings: "Findings", state: "State", next: "Next", facts: "Project facts" });

/** Transcript-side fold of ```state fences — display only, the wire payload is untouched.
 * `foldStateFences` injects the digest lines as a markdown quote block.
 *
 * Bilingual display layer: detection `PI_LANG` (explicit override) > `LANG` > `LC_ALL`,
 * `zh*` → Chinese, else English. Frozen import-time snapshot — env vars are process-level
 * constants, not session state. Wire prompts (model-facing) stay English by design. */
export type SigmaLocale = "zh" | "en";
/** Session-scoped display override, seeded from rlm.json `displayLocale` at boot and on
 * panel save. Module-level mutable by design: renderers resolve per call so a panel save
 * re-localizes stage cards/status lines without a restart. Never touches wire prompts. */
let sigmaOverride: SigmaLocale = "en";

/** Set the plugin-wide display language (rlm.json `displayLocale`). */
export function setDisplayLocale(v: SigmaLocale): void {
  sigmaOverride = v;
}

/** The ONE locale resolver — display-layer strings across the plugin (stage cards, status
 * line, Σ fold, config panel) resolve through this instead of ad-hoc literals.
 * Precedence: explicit arg (panel pass-through) > session override (rlm.json). Default English. */
export function resolveSigmaLocale(override?: SigmaLocale): SigmaLocale {
  return override ?? sigmaOverride;
}

const SIGMA_STRINGS: Readonly<Record<SigmaLocale, Readonly<{
  header: string;
  tail: string;
  plain: string;
  plainSuffix: string;
  accepted: string;
  rejected: string;
  sections: Readonly<Record<string, string>>;
  cards: Readonly<{ digest: string; degrade: string; recover: string; distill: string }>;
  status: Readonly<{ elided: string; digest: string; degraded: string }>;
  panel: Readonly<{ title: string; labels: Readonly<Record<string, string>>; hint: string }>;
  intro: Readonly<{ on: string; off: string; guide: string }>;
  expand: string;
  notify: Readonly<{ saveFailed: string; aborted: string; pinnedRlm: string; pinnedLlm: string; rlmFollows: string }>;
  picker: Readonly<{
    titleLlm: string; titleRlm: string;
    cheapest: string; cheapestDesc: string;
    followSession: string; followSessionDesc: string;
    filterHint: string; modelsCount: string;
    backToProviders: string; backToModels: string; providerModels: string;
    reasoning: string; none: string; noReasoning: string;
    useLevel: string; useLevelFor: string; thinkingTitle: string;
    noModels: string;
  }>;
  descriptions: Readonly<Record<string, string>>;
}>>> = Object.freeze({
  zh: Object.freeze({
    header: "**Σ 已记录：**",
    tail: "*(其余 {n} 条已存档 — 数据流不变)*",
    plain: "*Σ 提交 — 已折叠，数据流不变*",
    plainSuffix: "（{a} 项接受{r}）",
    accepted: "项接受",
    rejected: "项被拒",
    sections: Object.freeze({ findings: "发现", verifiedFacts: "事实", testedApproaches: "方法", openQuestions: "疑问", artifacts: "产物" }),
    cards: Object.freeze({
      digest: "**◆ 摘要 #{i}** 折叠 {t} 轮 · {b} tok（重算 {r}）",
      degrade: "**⚠ Σ 已降级** 连续 {n}/{m} 轮无有效提交 · {reason}",
      recover: "**◆ Σ 已恢复** 提交 {a}/{t} 被接受",
      distill: "**◆ skill.state** +{n} 条蒸馏 · 共 {t}{byTag}",
    }),
    status: Object.freeze({ elided: "已省略 {n}", digest: "摘要 {n}", degraded: "已降级 {n}" }),
    panel: Object.freeze({
      title: "RLM 设置",
      labels: Object.freeze({
        maxDepth: "最大递归深度",
        maxIterations: "最大迭代轮数",
        execTimeoutS: "REPL 块超时（秒）",
        maxConcurrentSubcalls: "最大并发子调用",
        maxConcurrentChildren: "最大并发子引擎",
        maxTimeoutMs: "运行时限（分钟）",
        maxTokens: "Token 上限",
        maxErrors: "最大连续错误",
        orchestrator: "编排附加提示",
        compaction: "轨迹压缩",
        compactionThresholdPct: "压缩阈值（%）",
        rootSamplingMaxTokens: "主模型输出上限（tok）",
        smartReasoning: "主模型推理力度",
        subSamplingMaxTokens: "子调用输出上限（tok）",
        subSamplingTemperature: "子调用采样温度",
        sandboxInitTimeoutMs: "沙箱初始化超时",
        requestTimeoutMs: "沙箱请求超时（分钟）",
        contextLoader: "上下文加载器",
        autoSeedCwd: "自动注入工作目录",
        displayLocale: "界面语言",
        __sigma_window__: "Root Σ 窗口（校准）",
        __save__: "保存并关闭",
      }),
      hint: "↑↓ 移动 · 回车 修改 · esc 保存并关闭",
    }),
    intro: Object.freeze({
      on: "● RLM 已开启 — llm={llm} · rlm={rlm}",
      off: "○ RLM 已关闭",
      guide: `# RLM 模式

{state}

## 命令

- \`/rlm\` — 切换 RLM 模式（快捷键 Ctrl+Shift+R）。关闭时也会中止正在运行的查询。
- \`/rlm-llm\` — 为 llm_query / llm_batch / map_files 固定 LLM 模型
- \`/rlm-rlm\` — 为 rlm_query / rlm_batch 子引擎固定模型（默认：会话模型）
- \`/rlm-config\` — 运行限制与引擎设置
- \`/rlm-stop\` — 中止所有进行中的 RLM 工作：RLM 运行、原生 repl 单元与后台任务（用 /rlm 或 Ctrl+Shift+R 退出 RLM 模式）

## 实时树

代理运行时，编辑器下方会显示一棵树 — Ctrl+R 聚焦，Enter 打开某个代理的时间线。`,
    }),
    expand: "展开",
    notify: Object.freeze({
      saveFailed: "RLM：设置保存失败（~/.pi/agent/rlm.json）",
      aborted: "RLM 工作已中止 — 运行、repl 单元与后台任务均已停止。",
      pinnedRlm: "RLM：固定模型 rlm={m} 暂不可用 — 在其恢复前跟随会话模型",
      pinnedLlm: "RLM：固定模型 llm={m} 暂不可用 — 在其恢复前暂用最便宜模型",
      rlmFollows: "RLM：rlm 跟随会话模型",
    }),
    picker: Object.freeze({
      titleLlm: "LLM 模型 — 提供商",
      titleRlm: "RLM 模型 — 提供商",
      cheapest: "⟳ 最便宜（自动）",
      cheapestDesc: "始终使用已配置密钥中最便宜的模型",
      followSession: "⌁ 跟随会话模型",
      followSessionDesc: "rlm_query / rlm_batch 子引擎使用 pi 当前活动模型",
      filterHint: "↑↓ 移动 • 输入过滤 • 回车选择 • esc 取消",
      modelsCount: "{n} 个模型",
      backToProviders: "← 返回提供商",
      backToModels: "← 返回 {p} 模型",
      providerModels: "{p} › 模型",
      reasoning: "支持推理",
      none: "无",
      noReasoning: "不使用推理",
      useLevel: "使用 {l} 档推理",
      useLevelFor: "为 {m} 使用 {l} 档推理",
      thinkingTitle: "思考力度",
      noModels: "RLM：无可用模型（在 Pi 中添加提供商密钥，或放宽 --models / enabledModels）",
    }),
    descriptions: Object.freeze({
      maxDepth: "超过此深度的 rlm_query 退化为普通 llm_query（1 = 不递归）。",
      maxIterations: "根 REPL 最大轮数，超过后 RLM 要求模型给出最终答案。默认值刻意偏大——运行通常先以 FINAL/错误/时限结束。",
      execTimeoutS: "单个模型编写的 Python REPL 块的执行时限。",
      maxConcurrentSubcalls: "llm_batch 与 rlm_batch 的并发池大小。",
      maxConcurrentChildren: "每深度并发的 rlm_query 子引擎数。每个都是持有继承上下文副本的 Python 进程。",
      maxTimeoutMs: "整棵递归树的运行时限；none 表示不设限。",
      maxTokens: "整棵递归树的输入+输出 token 上限。",
      maxErrors: "连续失败轮数达到此值后停止；none 表示关闭该防护。",
      orchestrator: "在根模型系统提示后附加额外的分治指导。",
      compaction: "历史接近模型上下文窗口时压缩旧轮次。",
      compactionThresholdPct: "触发压缩的上下文占比。",
      rootSamplingMaxTokens: "根模型每轮最大输出 token。调低可让每轮更精简。",
      smartReasoning: "根模型思考力度（'default' = 关闭）。仅注册表支持推理的模型会思考，其余静默运行。推理 token 计入输出上限——开启思考时请调高根输出上限。",
      subSamplingMaxTokens: "每个叶子子调用（llm_query / llm_batch / map_files）的最大输出 token。",
      subSamplingTemperature: "叶子子调用的采样温度；'default' = 提供方默认。确定性抽取（temp 0）是 r3 基准稳定的依据。",
      sandboxInitTimeoutMs: "等待 Python worker 启动的时间。",
      requestTimeoutMs: "父侧对每个沙箱请求的看门狗；超时则杀掉 Python worker。",
      contextLoader: "允许 add_context() 把外部目录、文件、文档或 git 仓库拉入上下文。",
      autoSeedCwd: "首次 repl() 调用时把工作目录注入上下文（否则从空开始）。",
      displayLocale: "界面文本语言（Σ 折叠、阶段卡片、状态行、本面板）。默认英文；模型面提示词保持英文。",
      __save__: "保存这些设置并关闭（Esc 同样保存）。",
    }),
  }),
  en: Object.freeze({
    header: "**Σ recorded:**",
    tail: "*(+{n} more archived — data flows unchanged)*",
    plain: "*Σ commit — folded, data flows unchanged*",
    plainSuffix: " ({a} accepted{r})",
    accepted: "accepted",
    rejected: "rejected",
    sections: Object.freeze({ findings: "finding", verifiedFacts: "fact", testedApproaches: "approach", openQuestions: "question", artifacts: "artifact" }),
    cards: Object.freeze({
      digest: "**◆ digest #{i}** folded {t} turns · {b} tok (recomputed {r})",
      degrade: "**⚠ Σ degraded** idle {n}/{m} fence-eligible turns · {reason}",
      recover: "**◆ Σ recovered** fences accepted {a}/{t}",
      distill: "**◆ skill.state** +{n} notes distilled · {t} total{byTag}",
    }),
    status: Object.freeze({ elided: "elided {n}", digest: "digest {n}", degraded: "degraded {n}" }),
    panel: Object.freeze({
      title: "RLM settings",
      labels: Object.freeze({
        maxDepth: "Max recursion depth",
        maxIterations: "Max iterations",
        execTimeoutS: "REPL block timeout (s)",
        maxConcurrentSubcalls: "Max concurrent sub-calls",
        maxConcurrentChildren: "Max concurrent children",
        maxTimeoutMs: "Wall-clock ceiling (min)",
        maxTokens: "Token ceiling",
        maxErrors: "Max consecutive errors",
        orchestrator: "Orchestrator addendum",
        compaction: "Trajectory compaction",
        compactionThresholdPct: "Compaction threshold (%)",
        rootSamplingMaxTokens: "Root model output cap (tok)",
        smartReasoning: "Root reasoning effort",
        subSamplingMaxTokens: "Worker output cap (tok)",
        subSamplingTemperature: "Worker sampling temperature",
        sandboxInitTimeoutMs: "Sandbox init timeout",
        requestTimeoutMs: "Sandbox request timeout (min)",
        contextLoader: "Context loader",
        autoSeedCwd: "Auto-seed cwd",
        displayLocale: "Display language",
        __sigma_window__: "Root Σ window (calibration)",
        __save__: "Save & close",
      }),
      hint: "↑↓ move · enter change · esc save & close",
    }),
    intro: Object.freeze({
      on: "● RLM ON — llm={llm} · rlm={rlm}",
      off: "○ RLM OFF",
      guide: `# RLM mode

{state}

## Commands

- \`/rlm\` — toggle RLM mode (shortcut: Ctrl+Shift+R). Turning it OFF also stops a running query.
- \`/rlm-llm\` — pin the LLM model for llm_query / llm_batch / map_files
- \`/rlm-rlm\` — pin the model for rlm_query / rlm_batch child engines (default: session model)
- \`/rlm-config\` — run limits and engine settings
- \`/rlm-stop\` — abort all in-flight RLM work: RLM runs, native repl cells and background tasks (use /rlm or Ctrl+Shift+R to leave RLM mode)

## Live tree

While agents run, a tree shows below the editor — Ctrl+R focuses it, Enter opens an agent's timeline.`,
    }),
    expand: "to expand",
    notify: Object.freeze({
      saveFailed: "RLM: failed to save settings to ~/.pi/agent/rlm.json",
      aborted: "RLM work aborted — runs, repl cells and background tasks stopped.",
      pinnedRlm: "RLM: pinned rlm={m} unavailable — following session model until it is",
      pinnedLlm: "RLM: pinned llm={m} unavailable — using cheapest until it is",
      rlmFollows: "RLM: rlm follows session model",
    }),
    picker: Object.freeze({
      titleLlm: "LLM model — provider",
      titleRlm: "RLM model — provider",
      cheapest: "⟳ cheapest (auto)",
      cheapestDesc: "Always use the cheapest model with a configured key",
      followSession: "⌁ follow session model",
      followSessionDesc: "rlm_query / rlm_batch child engines use pi's active model",
      filterHint: "↑↓ navigate • type to filter • enter select • esc cancel",
      modelsCount: "{n} models",
      backToProviders: "← providers",
      backToModels: "← {p} models",
      providerModels: "{p} › models",
      reasoning: "reasoning",
      none: "none",
      noReasoning: "No reasoning",
      useLevel: "Use {l} reasoning",
      useLevelFor: "Use {l} reasoning for {m}",
      thinkingTitle: "Thinking level",
      noModels: "RLM: no models available (add a provider key in Pi, or widen --models / enabledModels)",
    }),
    descriptions: Object.freeze({
      maxDepth: "rlm_query past this depth degrades to plain llm_query (1 = no recursion).",
      maxIterations: "Maximum root REPL turns before RLM asks the model for a final answer. Large by design — runs end on FINAL/errors/wall-clock first.",
      execTimeoutS: "Wall-clock limit for one model-authored Python REPL block.",
      maxConcurrentSubcalls: "Concurrency pool size for llm_batch and rlm_batch.",
      maxConcurrentChildren: "Concurrent rlm_query child engines per depth. Each is a Python process holding its own copy of the inherited context.",
      maxTimeoutMs: "Total runtime cap for the whole recursive tree; none disables the cap.",
      maxTokens: "Total input+output token cap for the whole recursive tree.",
      maxErrors: "Stop after this many consecutive failing turns; none disables the guard.",
      orchestrator: "Append extra divide-and-conquer guidance to the root model system prompt.",
      compaction: "Summarize old turns when history approaches the model context window.",
      compactionThresholdPct: "Context-window share that triggers compaction.",
      rootSamplingMaxTokens: "Max output tokens per root-model turn. Lower values keep each turn lean.",
      smartReasoning: "Thinking effort for the root model ('default' = none). Only models whose registry entry supports reasoning will think; others silently run without it. Reasoning tokens share the output cap — raise the root output cap when thinking is on.",
      subSamplingMaxTokens: "Max output tokens per leaf sub-call (llm_query / llm_batch / map_files).",
      subSamplingTemperature: "Sampling temperature for leaf sub-calls; 'default' = provider default. Deterministic extraction (temp 0) is what made the r3 bench stable.",
      sandboxInitTimeoutMs: "How long to wait for the Python worker to start.",
      requestTimeoutMs: "Parent-side watchdog per sandbox request; on breach the Python worker is killed.",
      contextLoader: "Allow add_context() to pull an external dir, file, document, or git repo into context.",
      autoSeedCwd: "Seed the working directory into context on the first repl() call (otherwise starts empty).",
      displayLocale: "Language for UI-facing text (Σ fold, stage cards, status line, this panel). Defaults to English; model-facing wire prompts stay English.",
      __save__: "Save these settings and close (Esc also saves).",
    }),
  }),
});


/** Template filler for the display-layer string tables — `{key}` placeholders, nothing more. */
export function fillTpl(tpl: string, vars: Readonly<Record<string, string | number>>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Stage-card + status-line wording — display layer only. Resolved per call so a
 * `setDisplayLocale()` from the config panel re-localizes immediately. */
export function sigmaStrings(override?: SigmaLocale): Readonly<(typeof SIGMA_STRINGS)["zh"]> {
  return SIGMA_STRINGS[resolveSigmaLocale(override)];
}

export const SIGMA_DIGEST_MAX_ITEMS = 4;
export const SIGMA_DIGEST_ITEM_CAP = 110;

const clip = (s: string): string =>
  s.length <= SIGMA_DIGEST_ITEM_CAP ? s : `${s.slice(0, SIGMA_DIGEST_ITEM_CAP)}…`;

const oneLine = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(oneLine).join("; ");
  if (isRecord(v)) {
    // testedApproaches entries: {status, reason}
    const status = typeof v["status"] === "string" ? v["status"] : "?";
    const reason = typeof v["reason"] === "string" ? v["reason"] : "";
    return reason !== "" ? `${status} — ${reason}` : status;
  }
  return String(v);
};

/** Human-readable fold digest — single source for the folded fence display.
 * Takes the `StateFenceResult`s from `findStatePatches` (already JSON-parsed on the ok
 * branch); shows WHAT was recorded (up to `SIGMA_DIGEST_MAX_ITEMS` clipped lines, then a
 * tail count), falling back to a plain one-liner when nothing parses. Fail-soft by design.
 * Keys arrive as `verifiedFacts[+]` (append) or `testedApproaches.h1` (dotted write).
 * `override` comes from rlm.json `displayLocale`. */
export function sigmaFenceDigest(
  fences: readonly { readonly ok: boolean; readonly value?: unknown }[],
  accepted: number,
  problems: number,
  override?: SigmaLocale,
): string {
  const s = sigmaStrings(override);
  const labels = s.sections;
  const lines: string[] = [];
  let total = 0;
  for (const fence of fences) {
    if (!fence.ok) continue;
    const body = isRecord(fence.value) ? fence.value["state_patch"] : undefined;
    if (!isRecord(body)) continue;
    for (const [key, value] of Object.entries(body)) {
      const section = key.replace(/\[\+\]$/, "").split(".")[0] ?? key;
      const label = labels[section];
      if (label === undefined) continue;
      const entries = Array.isArray(value)
        ? value.map((v) => ["", v] as const)
        : isRecord(value)
          // dotted write (testedApproaches.h1) = ONE entry; record section (artifacts) = each key an entry
          ? key.includes(".")
            ? [["", value] as const]
            : Object.entries(value).map(([k, v]) => [k, v] as const)
          : [["", value] as const];
      for (const [id, v] of entries) {
        total++;
        if (lines.length < SIGMA_DIGEST_MAX_ITEMS) {
          // dotted write: id lives in the key (testedApproaches.h1), not in entries
          const shownId = id !== "" ? id : key.includes(".") ? (key.split(".").at(-1) ?? "") : "";
          const name = shownId !== "" ? `${shownId}: ` : "";
          lines.push(section === "artifacts" ? `- \`${shownId}\` — ${clip(oneLine(v))}` : `- ${label} ${name}${clip(oneLine(v))}`);
        }
      }
    }
  }
  const rejectNote = problems > 0 ? ` · ${problems} ${s.rejected}` : "";
  if (lines.length === 0) {
    const suffix = rejectNote !== "" ? fillTpl(s.plainSuffix, { a: accepted, r: rejectNote }) : "";
    return `${s.plain.slice(0, -1)}${suffix}*`;
  }
  const parts = [s.header, ...lines];
  if (total > lines.length) parts.push(fillTpl(s.tail, { n: total - lines.length }));
  if (rejectNote !== "") parts.push(`*(${rejectNote.replace(" · ", "")})*`);
  return parts.join("\n");
}

/** One-line delegation helpers — orchestrating must be cheaper than solving. */
const DELEGATION_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `map_files(files, prompt) -> Task`: always spawn. `await_task(t)` → dict[path, answer].",
  "  Accepts context entries or paths; packs into cap-sized batches; splits oversized files.",
  "  **Default way to read many files** — fire independent `map_files` Tasks, free work, then await.",
  "- `llm_map_reduce(items, map_prompt, reduce_prompt) -> str`: **blocks** (map then reduce).",
  "  Prefer separate `map_files` / `llm_batch` Tasks when you can do free work between fan-out and collect.",
]);

/** Shared glossary entry for the chunked-query helper (headless + native). */
const CHUNKED_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- `llm_query_chunked(text: str, prompt: str) -> Task`: always spawn. `await_task(t)` → list[str]",
  "  (one answer per chunk, order preserved). Auto-splits text to the sub-LLM prompt cap.",
  "  Use for ANY text too large for a single `llm_query` — open()ed files, oversized sub-results.",
]);

/** Non-blocking fan-out: spawn now, collect later (headless glossary). */
const SPAWN_GLOSSARY_LINES: readonly string[] = Object.freeze([
  "- **ALWAYS SPAWN (Task + ↗bg):** `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` /",
  "  `map_files` / `llm_query_chunked`. Never treat the return as the answer.",
  "  Collect with `await_task(t)`, `await_task([t1,t2,…])`, or `await_task()` (every still-running Task).",
  "  If `await_task` returns `Error: sub-call still running`, call it again — do not respawn.",
  "  `list_tasks()` → [{kind, label, done, var}]. Fire independent Tasks first, free work, then await.",
  "  Do NOT await after every independent spawn (serializes wall time). `task.done` when settled.",
  "- `[ledger]` global state: the blackboard in your prompt lists inflight/done agent claims.",
  "  NEVER `rlm_query` a task already on `[ledger]` (await it / reuse the result); ancestor",
  "  echo is rejected with a stub. `list_claims()` shows the live table anytime.",
  "- `spawn(fn, *args) -> Task`: same as calling the always-spawn tools (not `llm_map_reduce`).",
  "- Only `llm_map_reduce` still blocks until done.",
]);

/** v5 (audit C5): the spawn worked example, retrieval flavor — root surface only. */
const SPAWN_EXAMPLE_RETRIEVAL: readonly string[] = Object.freeze([
  "",
  "  ```python",
  "  # Multi-area study: one rlm_batch (parallel workers), free locate, then await",
  "  t = rlm_batch([",
  "      \"Study module A — NO edits. Paths + symbols for X.\",",
  "      \"Study module B — NO edits. Report how Y is configured.\",",
  "  ])",
  "  hits = search(\"X OR Y\", k=10)",
  "  reports = await_task(t)",
  "  # One-shot extracts: map_files / llm_batch also return Task → await_task",
  "  ```",
]);

/** v5 (audit C5): the spawn worked example, delegation flavor — no retrieval, slice instead. */
const SPAWN_EXAMPLE_DELEGATION: readonly string[] = Object.freeze([
  "",
  "  ```python",
  "  # Multi-area study: one rlm_batch (parallel workers), slice your world while they run",
  "  t = rlm_batch([",
  "      \"Answer from the FIRST half of the context only: paths + symbols for X.\",",
  "      \"Answer from the SECOND half only: report how Y is configured.\",",
  "  ])",
  "  half = [f['path'] for f in context[:len(context)//2]]  # free work while Tasks run",
  "  reports = await_task(t)",
  "  # One-shot extracts: map_files / llm_batch also return Task → await_task",
  "  ```",
]);
const RECURSION_CONTEXT_LINES: readonly string[] = Object.freeze([
  "",
  "  **What a child sees:** it inherits YOUR `context` — every file you have loaded, including",
  "  sources under `ctx/<id>/…` — and runs `search` / `grep_context` / `outline` / `map_files`",
  "  over the same paths. So send instructions, never file bodies: pasting content you already",
  "  share costs your tokens twice and buys nothing. Your prompt becomes the child's question.",
  "  Narrow its world with `rlm_query(prompt, paths=['src/auth/', 'ctx/x-9f3a/'])` — path PREFIXES,",
  "  not globs. Omit `paths` to hand over everything.",
  "  Inheritance is one-way: sources the child loads, and its whole REPL, die with it — only its",
  "  final answer string returns. The child cannot write to your `answers` or `plan`.",
  "  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context, which is why",
  "  this section disappears at the last recursive depth.",
]);

/** v5 recursion section, delegation variant (audit C5): describes what a delegation child
 *  receives — the narrowed pack as text, no retrieval of its own. */
const RECURSION_DELEGATION_LINES: readonly string[] = Object.freeze([
  "",
  "  **What a child sees:** it inherits YOUR `context` (narrowed by `paths=` when given) and works",
  "  on it as text — it has NO retrieval tools, so put what matters in your prompt and `paths`,",
  "  never file bodies you already share (that costs tokens twice and buys nothing).",
  "  Inheritance is one-way: sources the child loads, and its whole REPL, die with it — only its",
  "  final answer string returns. The child cannot write to your `answers` or `plan`.",
  "  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context, which is why",
  "  this section disappears at the last recursive depth.",
]);

/**
 * Sub-RLM orientation. Emitted only at depth > 0, where `context` is the parent's world rather
 * than a repository the run packed for itself.
 */
const CHILD_CONTEXT_LINES: readonly string[] = Object.freeze([
  "  You are a sub-RLM. This `context` is your parent's world — every file it has loaded (cwd",
  "  paths un-prefixed; external sources under `ctx/<id>/…`). Answer only the question above;",
  "  your REPL and anything you load die with you, and only your final answer string returns.",
]);

/** Why a file the user mentioned may be missing from `context`. */
const CONTEXT_EXCLUSION_NOTE = [
  "  NOTE: `context` holds only the files you have loaded (starts empty; cwd seeds on first use).",
  "  Gitignored files and files larger than 1MB of plain text are skipped. Binary documents",
  "  (PDF, DOCX, XLSX, PPTX, CSV, …) ARE included — converted to Markdown on the way in.",
].join("\n");

/** Stdout-budget wording — the ONE source for the per-print / per-block elision markers.
 *  core/answer.ts composes these into its segments (head/tail math stays in
 *  text/parsing.ts truncateOutput); guidance numbers live in limits.ts + system.ts. */
export function stdoutElidedMark(cutChars: number, capChars: number): string {
  return `[… ${cutChars.toLocaleString()} chars elided — per-print stdout cap ${capChars.toLocaleString()}; ` +
    "full output lives in your REPL vars, re-print the slice you need: print(big_var[a:b])]";
}

export function stdoutBulkMark(elidedCount: number, capChars: number): string {
  return `[… ${elidedCount} middle print output(s) elided — per-block stdout cap ${capChars.toLocaleString()}; ` +
    "slice big dumps in Python (print(v[a:b])) or delegate bulk reading to llm_query_chunked]";
}

/** The large-on-disk-file protocol (headless + native). */
export const LARGE_FILE_RULE_LINES: readonly string[] = Object.freeze([
  "**Large on-disk files (profiles, logs, dumps, generated JSON):** files >1MB or gitignored are",
  "absent from `context`. Protocol:",
  '1. Load in Python: `raw = open("dhat-heap.json").read()` — loading into a variable is fine.',
  "2. Deterministic processing in Python (`json.load`, `re`, counting, aggregation) is fine and preferred.",
  "3. The moment you need MEANING from raw text (summarize, explain, find anomalies), do NOT read it",
  "   yourself — call `llm_query_chunked(raw, question)` (Task → await_task), or slice + `llm_batch`.",
  "4. Prints are per-call capped — slice big text in Python and print only the slice you need, or delegate bulk reading (llm_query_chunked).",
  'Example: `t = llm_query_chunked(raw, "Extract top allocation sites with byte totals"); parts = await_task(t)`, then',
  "aggregate `parts` in Python or with one final `llm_query` + await_task.",
]);

/** Concise native-mode glossary line for the chunked helper (native prompt has a 6K budget). */
export const CHUNKED_GLOSSARY_LINE_NATIVE =
  "- `llm_query_chunked(text, prompt) -> Task` — always spawn; await_task → list[str] (one answer per chunk). Auto-splits oversized text.";

/** Concise native-mode large-file rule (folds in the context-exclusion note; native 6K budget). */
export const LARGE_FILE_RULE_NATIVE =
  "- Files >1MB or gitignored are NOT in `context`: open() + parse deterministically in Python is fine; ANY semantic reading of the raw text goes through llm_query_chunked. Never bulk-print raw text; prints are per-call capped — slice or delegate.";

/**
 * The decomposition doctrine, ported from the RLM paper's Appendix C.3 `<env_tips>` and
 * retargeted from competition math to repository analysis.
 *
 * This block is the single highest-leverage prompt intervention the paper reports: +69.5% on
 * LongCoT-mini over the same RLM without it (Table 2). Plain RLM prompting alone actually
 * *regressed* two of the five categories; the doctrine is what fixed them. Its purpose is to
 * counter under-delegation — the model doing the work itself in the REPL instead of fanning out.
 *
 * Note the counterweight: `orchestratorAddendum` carries the anti-OVER-recursion batching rule.
 * The paper is explicit (App. B) that one prompt does not port across models and that both
 * guardrails are needed; keep them both.
 */
/** Decomposition doctrine. `delegation` drops retrieval names (audit R3) — children
 *  have no `search` and must not be told to locate with it. */
export function envTips(delegation = false): string {
  const locate = delegation
    ? "Your job: (1) slice `context` with Python (indexing, string matching, comprehensions),"
    : "Your job: (1) free locate with `search` / `grep_context` / `outline`,";
  const probe = delegation
    ? "1. Probe: `print(len(context))`; locate targets with Python slicing / string matching. Do not print file bodies."
    : "1. Probe: `print(len(context))`; locate targets with `search` when your surface has it, else\n   Python slicing / string matching. Do not print file bodies.";
  return [
    "## Decomposition doctrine",
    "",
    "**Orchestrate; don't solve.** A single chain of thought over a large repository drifts —",
    "you lose partials and compound mistakes. Sub-workers are competent: trust them; don't read for them.",
    "",
    locate,
    "(2) fan out: **multi-step areas → `rlm_batch` / `rlm_query`**; one-shot extracts →",
    "  `map_files` / `llm_batch` (all return Task — `await_task` for content),",
    "(3) memoize into `answers`, (4) sanity-check before dependents, (5) assemble from `answers`.",
    "Your own compute is: pointers, dict lookups, string formatting, and decisions.",
    "",
    "### The only state that matters",
    "`answers` and `plan` are dicts that persist across every turn.",
    "**If a result isn't in `answers`, you have not memoized it.** Task handles are REPL vars —",
    "`list_tasks()` / `SHOW_VARS()` find them. Do not trust truncated stdout. Memoize after await_task.",
    "",
    "### Shape of a run",
    probe,
    "2. Plan: sub-questions into `plan` (each from a named slice / module).",
    "3. Fan out **in parallel**: one `rlm_batch` for independent multi-step studies, or",
    "   `map_files` / `llm_batch` for one-shot reads — not one serial call per file.",
    "4. Assemble from `answers`.",
    "",
    "### Red flags — you are off track",
    "- Printing file bodies / native bulk read → stop; use map_files or rlm_*.",
    "- `llm_query(\"Read src/foo.ts…\")` with only a path — sub-LLM has **no disk**; use map_files/rlm_*.",
    "- Multi-module task with zero `rlm_batch`/`rlm_query`/`map_files` → under-delegating.",
    "- Await after every independent spawn → serializes wall time; fire-all-then-await.",
    "- Treating Task as the answer without `await_task`.",
    "- Regex used to *infer meaning* → sub-LLM job. Regex is for exact needles only.",
    "- Two turns with zero sub-LLM calls on analysis → solving it yourself.",
  ].join("\n");
}

/** Native-mode variant of the doctrine — same rules, sized for the native prompt budget. */
export const ENV_TIPS_CONDENSED = [
  "### Decomposition doctrine",
  "Orchestrate; don't solve. Free locate → fan-out Tasks → await_task → memoize in `answers`.",
  "Multi-module / multi-step areas: **`rlm_batch` (or rlm_query)** — not serial native read.",
  "One-shot extracts: `map_files` / `llm_batch`. Always Task → await_task; fire-all then await.",
  "`answers`/`plan` persist collected results. Task handles are REPL vars (`list_tasks()` / `SHOW_VARS()`).",
  "Red flags: bulk file dumps; llm_query with path-only (no content — no disk!); zero rlm_*/map_files",
  "on multi-area tasks; await after each spawn; Task treated as answer.",
  "AUTHORING: you write every edit body yourself.",
].join("\n");

export function howToRunCode(): string {
  return [
    "To run Python, write a fenced ```repl``` block. The REPL **persists** across turns.",
    "Stdout is what comes back: `print(...)`, and the value of a trailing bare expression",
    "(it is echoed). Anything that is not the last line still needs `print`.",
  ].join(" ");
}

/** One wording for both prompts: `ctx/<id>/` names are inside `context`, not on disk. */
export const CTX_VIRTUAL_PATH_NOTE =
  "`ctx/<id>/…` paths are keys inside `context`, not disk paths. Read with `outline(path)` " +
  "or `next(f[\"content\"] for f in context if f[\"path\"] == path)`.";

export function replGlossary(
  kind: ContextKind,
  recursion: boolean,
  contextLoader: boolean,
  child: boolean,
  delegation = false,
): string {
  const lines = ["Available in the REPL:"];
  if (kind === "text") {
    lines.push(
      "- `context`: str — the raw text you must analyze. Probe it with slices",
      "  (`print(context[:2000])`), split it programmatically, and delegate large chunks",
      "  to sub-LLMs — never dump the whole string into your own output.",
    );
  } else {
    lines.push(
      "- `context`: list[dict] — the files you have loaded (starts empty; cwd seeds on first use).",
      "  Each dict has keys: `path` (str), `content` (str), `tokens` (int).",
      "  Cwd paths are un-prefixed (real paths for edit/write); external sources land under",
      "  `ctx/<source_id>/…`. " + CTX_VIRTUAL_PATH_NOTE,
      "  For large sets, chunk and delegate — never dump raw file bodies.",
      CONTEXT_EXCLUSION_NOTE,
    );
    if (child) lines.push(...CHILD_CONTEXT_LINES);
    if (delegation) {
      lines.push(
        "",
        "  Worked example — slice the world you were handed, then delegate it (Task + await):",
        "  ```python",
        "  slice = [f for f in context if f['path'].startswith('src/auth/')][:6]",
        "  prompts = [f\"Answer from this file only.\\n\\n{f['content'][:4000]}\" for f in slice]",
        "  t = llm_batch(prompts)",
        "  answers.update(dict(zip([f['path'] for f in slice], await_task(t))))",
        "  ```",
      );
    } else {
      lines.push(
        "",
        "  Worked example — find the slice, then delegate it (Task + await):",
        "  ```python",
        '  hits = search("where is the retry/backoff policy configured?", k=8)',
        "  paths = sorted({h['path'] for h in hits})",
        '  t = map_files(paths, "Describe any retry/backoff policy in this file, with line numbers. Say NONE if absent.")',
        "  answers.update(await_task(t))",
        "  print({p: a[:80] for p, a in answers.items()})",
        "  ```",
      );
    }
  }
  if (delegation) {
    lines.push(...DELEGATION_SURFACE_LINES);
  } else {
    lines.push(...RETRIEVAL_GLOSSARY_LINES);
  }
  lines.push(
    "- `llm_query(prompt: str) -> Task`: spawn one sub-LLM (await_task for str). The prompt must",
    "  **contain the text** to analyze — this call has no filesystem and no `context`.",
    "  Leaf convention: a sub-LLM answers exactly `NOT_FOUND` when its slice lacks the answer —",
    "  treat that as \"not in this slice\": slice differently, search elsewhere, or narrow the ask.",
    "  Never re-send an identical prompt hoping for a different verdict.",
    "- `llm_batch(prompts: list[str]) -> Task`: many parallel one-shots (same rule: embed text).",
    "  await_task → ordered list[str]. NEVER pass bare file paths as if the worker can open them.",
    ...CHUNKED_GLOSSARY_LINES,
    ...SPAWN_GLOSSARY_LINES,
    ...SKILL_SEARCH_GLOSSARY_LINES,
    ...(delegation ? SPAWN_EXAMPLE_DELEGATION : SPAWN_EXAMPLE_RETRIEVAL),
    ...DELEGATION_GLOSSARY_LINES,
  );
  if (contextLoader && !delegation) {
    lines.push(
      "- `add_context(source: str) -> dict`: load a dir, file, document, or git URL and **APPEND its",
      "  files into `context`** (same shape: path/content/tokens). Documents (PDF, DOCX, XLSX, PPTX,",
      "  CSV, …) are converted to Markdown automatically and cached until the source file changes.",
      "  Paths are namespaced under `ctx/<source_id>/…` so you can filter by prefix. Returns metadata:",
      "  {\"source\", \"source_id\", \"path_prefix\", \"files\", \"chars\", \"context_len\", \"already_loaded\",",
      "  \"documents\", \"converted\", \"skipped\"} or an \"Error: ...\" string. `documents` is how many",
      "  document-type files landed (incl. cache hits); `converted` is how many were freshly converted",
      "  this call. **Never treat the return value as the file list** — always search and chunk the",
      "  single variable `context`. Idempotent: re-loading the same source is a no-op.",
      "",
      "  ```python",
      '  info = add_context("/path/to/other-project")',
      "  # info is metadata; files are already in context under info[\"path_prefix\"]",
      '  lib_files = [f for f in context if f["path"].startswith(info["path_prefix"])]',
      "  ```",
    );
  }
  if (recursion) {
    lines.push(
      "- `rlm_query(task|prompt, paths=None) -> Task` / `rlm_batch(tasks|prompts, paths=None) -> Task`:",
      "  always spawn + ↯bg. await_task for the report string(s). Child REPL is private.",
      "  Both spellings accepted; prefer `task`/`tasks`.",
      "",
      "  **Routing (api_v5):**",
      "  - `llm_query` / `llm_batch` / `map_files` — one-shot facts/extracts (fast).",
      delegation
        ? "  - `rlm_query` — one multi-step study (its own delegation loop; it cannot search either)."
        : "  - `rlm_query` — one multi-step study (own search/outline loop).",
      "  - `rlm_batch` — ≥2 independent multi-step studies in **parallel** (prefer over N× rlm_query).",
      "  Always Task → await_task. Fire independent work first; never serial-await between peers.",
      ...(delegation ? RECURSION_DELEGATION_LINES : RECURSION_CONTEXT_LINES),
    );
  }
  lines.push(
    "- `answers` / `plan`: two dicts that persist across turns. Memoize every",
    "  verified result in `answers` — see the decomposition doctrine below.",
    "- `SHOW_VARS() -> str`: list every variable currently in the REPL (Task handles show as `<Task …>`).",
    "- `list_tasks()`: every Task this REPL created — [{kind, label, done, var}].",
    "- `list_claims()`: the live `[ledger]` table of inflight/done agent work.",
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` to the answer text and `answer["ready"] = True`.',
    '  **You MUST flip `answer["ready"] = True` — runs that never finalize are discarded.**',
    '  Never write FINAL(...) / FINAL_VAR(...) prose and never emit a ```state fence in the',
    '  reply that finalizes — `answer` is the only finalize channel; Σ bookkeeping waits.',
  );
  return lines.join("\n");
}
