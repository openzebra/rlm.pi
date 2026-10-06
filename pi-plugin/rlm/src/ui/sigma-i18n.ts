/**
 * Display-layer i18n (zh/en) + the Σ fence digest — UI-facing wording ONLY.
 * Model-facing (wire) wording stays English in `prompts/glossary.ts`; nothing here is ever
 * sent to a model.
 */

import { isRecord } from "../util/type-guards.ts";

/** Transcript-side fold of ```state fences — display only; `foldStateFences` injects the
 * digest lines as a markdown quote block.
 *
 * Bilingual display layer: the language comes from rlm.json `displayLocale` (default "en"),
 * never from the environment. Wire prompts (model-facing) stay English by design. */
export type SigmaLocale = "zh" | "en";
/** Process-wide display language, seeded from rlm.json `displayLocale` at `session_start`
 * and on panel save. Module-level mutable by design (a display-only singleton, never part of
 * Σ or any wire text): renderers resolve per call so a panel save re-localizes stage
 * cards/status lines without a restart. */
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

/** Σ section keys the digest labels; zh/en tables must cover exactly these. */
const SIGMA_SECTION_KEYS = Object.freeze(["findings", "verifiedFacts", "testedApproaches", "openQuestions", "artifacts"] as const);
type SigmaSectionKey = (typeof SIGMA_SECTION_KEYS)[number];
const isSigmaSectionKey = (k: string): k is SigmaSectionKey => (SIGMA_SECTION_KEYS as readonly string[]).includes(k);

/** Config-panel row ids (label + description each); `__sigma_window__`/`__save__` are the
 * non-editable rows. One key union ⇒ tsc flags any zh/en drift. */
export type PanelKey =
  | "maxDepth" | "maxIterations" | "execTimeoutS" | "maxConcurrentSubcalls" | "maxConcurrentChildren"
  | "maxTimeoutMs" | "maxTokens" | "maxErrors" | "orchestrator" | "compaction" | "compactionThresholdPct"
  | "rootSamplingMaxTokens" | "smartReasoning" | "subSamplingMaxTokens" | "subSamplingTemperature"
  | "sandboxInitTimeoutMs" | "requestTimeoutMs" | "contextLoader" | "autoSeedCwd" | "displayLocale"
  | "__sigma_window__" | "__save__";

const SIGMA_STRINGS: Readonly<Record<SigmaLocale, Readonly<{
  header: string;
  tail: string;
  plain: string;
  plainSuffix: string;
  rejected: string;
  sections: Readonly<Record<SigmaSectionKey, string>>;
  cards: Readonly<{ digest: string; degrade: string; recover: string; distill: string }>;
  status: Readonly<{ elided: string; digest: string; degraded: string }>;
  panel: Readonly<{ title: string; labels: Readonly<Record<PanelKey, string>>; hint: string }>;
  intro: Readonly<{ on: string; off: string; guide: string }>;
  expand: string;
  notify: Readonly<{ saveFailed: string; aborted: string; idle: string; pinnedRlm: string; pinnedLlm: string; rlmFollows: string; rlmPinned: string; llmPinned: string; llmCheapest: string; noneAvailable: string }>;
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
  descriptions: Readonly<Record<PanelKey, string>>;
}>>> = Object.freeze({
  zh: Object.freeze({
    header: "**Σ 已记录：**",
    tail: "*(其余 {n} 条已存档 — 数据流不变)*",
    plain: "Σ 提交 — 已折叠，数据流不变",
    plainSuffix: "（{a} 项接受{r}）",
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
      idle: "当前没有进行中的 RLM 工作。",
      pinnedRlm: "RLM：固定模型 rlm={m} 暂不可用 — 在其恢复前跟随会话模型",
      pinnedLlm: "RLM：固定模型 llm={m} 暂不可用 — 在其恢复前暂用最便宜模型",
      rlmFollows: "RLM：rlm 跟随会话模型",
      rlmPinned: "RLM：rlm={m}{r}",
      llmPinned: "RLM：llm={m}{r}",
      llmCheapest: "（最便宜，自动）",
      noneAvailable: "（无可用模型）",
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
      compactionThresholdPct: "已弃用 — 被忽略：压缩使用绝对 256k 上限（COMPACTION_CEILING_TOKENS）。",
      rootSamplingMaxTokens: "根模型每轮最大输出 token。调低可让每轮更精简。",
      smartReasoning: "根模型思考力度（'default' = 关闭）。仅注册表支持推理的模型会思考，其余静默运行。推理 token 计入输出上限——开启思考时请调高根输出上限。",
      subSamplingMaxTokens: "每个叶子子调用（llm_query / llm_batch / map_files）的最大输出 token。",
      subSamplingTemperature: "叶子子调用的采样温度；'default' = 提供方默认。确定性抽取（temp 0）是 r3 基准稳定的依据。",
      sandboxInitTimeoutMs: "等待 Python worker 启动的时间。",
      requestTimeoutMs: "父侧对每个沙箱请求的看门狗；超时则杀掉 Python worker。",
      contextLoader: "允许 add_context() 把外部目录、文件、文档或 git 仓库拉入上下文。",
      autoSeedCwd: "首次 repl() 调用时把工作目录注入上下文（否则从空开始）。",
      displayLocale: "界面文本语言（Σ 折叠、阶段卡片、状态行、本面板）。默认英文；模型面提示词保持英文。",
      __sigma_window__: "查询期窗口校准，仅限 rlm.json：rootContextKeepTurns（默认 4）、rootContextElideChars、rootContextSnapshot、rootArchiveMaxChars（0 = 关闭归档；被省略的轮次否则无法找回）。会话恢复/分叉：tracker 惰性重建，Σ 由实时观察重新积累 — 恢复后的首次调用 Σ 为空，属设计如此。",
      __save__: "保存这些设置并关闭（Esc 同样保存）。",
    }),
  }),
  en: Object.freeze({
    header: "**Σ recorded:**",
    tail: "*(+{n} more archived — data flows unchanged)*",
    plain: "Σ commit — folded, data flows unchanged",
    plainSuffix: " ({a} accepted{r})",
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
      idle: "No RLM work in progress.",
      pinnedRlm: "RLM: pinned rlm={m} unavailable — following session model until it is",
      pinnedLlm: "RLM: pinned llm={m} unavailable — using cheapest until it is",
      rlmFollows: "RLM: rlm follows session model",
      rlmPinned: "RLM: rlm={m}{r}",
      llmPinned: "RLM: llm={m}{r}",
      llmCheapest: " (cheapest, auto)",
      noneAvailable: "(none available)",
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
      compactionThresholdPct: "DEPRECATED — ignored: compaction uses the absolute 256k ceiling (COMPACTION_CEILING_TOKENS).",
      rootSamplingMaxTokens: "Max output tokens per root-model turn. Lower values keep each turn lean.",
      smartReasoning: "Thinking effort for the root model ('default' = none). Only models whose registry entry supports reasoning will think; others silently run without it. Reasoning tokens share the output cap — raise the root output cap when thinking is on.",
      subSamplingMaxTokens: "Max output tokens per leaf sub-call (llm_query / llm_batch / map_files).",
      subSamplingTemperature: "Sampling temperature for leaf sub-calls; 'default' = provider default. Deterministic extraction (temp 0) is what made the r3 bench stable.",
      sandboxInitTimeoutMs: "How long to wait for the Python worker to start.",
      requestTimeoutMs: "Parent-side watchdog per sandbox request; on breach the Python worker is killed.",
      contextLoader: "Allow add_context() to pull an external dir, file, document, or git repo into context.",
      autoSeedCwd: "Seed the working directory into context on the first repl() call (otherwise starts empty).",
      displayLocale: "Language for UI-facing text (Σ fold, stage cards, status line, this panel). Defaults to English; model-facing wire prompts stay English.",
      __sigma_window__: "Query-time window calibrations, rlm.json only: rootContextKeepTurns (4 = default), rootContextElideChars, rootContextSnapshot, rootArchiveMaxChars (0 = archive off; elided turns are otherwise unrecoverable). Session resume/fork: the tracker is reborn lazily and Σ re-grows from live observations — the first call after a resume has an empty Σ by design.",
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

/** Model text → one display line: whitespace runs (incl. newlines) collapse so an item can
 * never break out of its `- ` list line or the quote block. */
const oneLine = (v: unknown): string => {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
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
      if (!isSigmaSectionKey(section)) continue;
      const label = labels[section];
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
    return `*${s.plain}${suffix}*`;
  }
  const parts = [s.header, ...lines];
  if (total > lines.length) parts.push(fillTpl(s.tail, { n: total - lines.length }));
  if (rejectNote !== "") parts.push(`*(${rejectNote.replace(" · ", "")})*`);
  return parts.join("\n");
}
