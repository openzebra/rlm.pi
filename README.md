<div align="center">

<sub>
<b>English</b> &nbsp;·&nbsp;
<a href="#中文">中文</a> &nbsp;·&nbsp;
<a href="#Русский">Русский</a>
</sub>

</div>

---

## English

# pi-rlm — Recursive Language Models for the [Pi](https://github.com/earendil-works) Coding Agent

<div align="center">

**Recursive Language Models (RLMs)**, implemented natively as a Pi extension —
no extra servers, no Docker, no sockets.

</div>

---

A **Recursive Language Model (RLM)** is a task-agnostic inference paradigm where a
root language model orchestrates over near-infinite context by *programmatically*
examining, decomposing, and **recursively calling itself** over its input. RLMs
replace the canonical `llm.completion(prompt, model)` call with an
`rlm.completion(prompt, model)` call: the prompt/context is offloaded as a variable
in a REPL environment that the model interacts with, and the model can launch
sub-LLM and sub-RLM calls as ordinary functions in code.

This is a bet on a [CodeAct](https://arxiv.org/abs/2402.01030)-style harness — every
language model gets access to a code environment, sub-(R)LM calls are functions, and
context/prompts are objects in code — moving away from the JSON tool-calling standard.
A system built this way is *itself* a language model that relies on recursive
sub-LLM calls, hence the name.

`pi-rlm` brings that paradigm **natively into Pi**:

- A **root orchestrator** model drives a **persistent Python REPL** turn-by-turn.
- Long-context work is **delegated** to cheap worker models via `llm_query` / `llm_query_batched`.
- Hard sub-problems **recurse** into child RLMs via `rlm_query` (depth-capped).
- Everything runs **in-process** — the only external process is one local `python3` worker.

> This is a Pi-plugin reimplementation of the RLM method (see the [RLM paper](https://arxiv.org/abs/2512.24601)
> and the [Python `rlm` library](https://github.com/alexzhang13/rlm-minimal)). It is **not** the Python library.

## How it works

```
pi process (TypeScript)
 ├─ /rlm  ──► engine drives the SMART (root) model turn-by-turn (writes ```repl``` Python)
 │             │  each turn: parse repl blocks ──► run in sandbox ──► feed stdout back
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER model (serverless, in-process)
 │            rlm_query ──► recursive child RLM (own sandbox), depth-capped
 ├─ AgentTree ──► live agent/subagent tree above the editor (roles, depth, cost, tokens)
 └─ PythonSandbox ── `python3 worker.py` ──[JSONL over stdio, bidirectional]── persistent REPL
```

- **No servers, no sockets, no Docker.** The only external process is one local `python3` sandbox.
  When sandbox code calls `llm_query`, the worker writes a request on stdout and blocks on stdin;
  Pi services it in-process and writes the reply back. **Provider API keys never enter the sandbox.**
- The sandbox exposes `context`, `llm_query`, `llm_query_batched`, `rlm_query`,
  `rlm_query_batched`, `SHOW_VARS()`, `todo()`, `ask_user_question()`, and an `answer` dict.
  The model submits its final result by setting `answer["ready"] = True`.

## Install

`pi-rlm` is a Pi package. Pi provides the `@earendil-works/pi-*` and `typebox` peer
dependencies; do **not** install a separate copy of them into this package. Requires
`python3` on `PATH` (standard library only).

Recommended local install while developing:

```bash
pi install /path/to/this-repo/pi-plugin/rlm
```

Published npm package install:

```bash
npm publish                       # e.g. as @<you>/pi-rlm
pi install npm:@<you>/pi-rlm
```

> **Git installs** require the package manifest to live at the installed repository root.
> For monorepo subdirectories like this one, prefer the local-path or npm flow above.

If you previously copied the extension folder directly, remove it so it does not shadow the package:

```bash
rm -rf ~/.pi/agent/extensions/rlm
```

Then run `/reload` or restart Pi. Verify with `pi list` that the package appears in
`settings.packages`, and check that `/rlm`, `/rlm-config`, and `/rlm-stop` appear under **[Extensions]**.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `/rlm` | `Ctrl+Shift+R` | Toggle persistent RLM mode (route plain prompts through the RLM engine) |
| `/rlm-stop` | | Abort an in-progress run |
| `/rlm-config` | | Pick smart + worker models and tune run settings |
| `/rlm-resume` | | Resume an interrupted run (default `@latest`) |
| `/rlm-runs` | | List recent runs |
| `/rlm-help` | | Show the startup guide & cheatsheet |

While a run is active, a **live tree** shows the root orchestrator and every sub-LLM /
recursive child with status, model, cost, tokens, and duration. The final answer is posted
to the chat as markdown; any code edits are collected as diffs and reviewed via a popup
(unless `yolo` is on).

## Sandbox API

These functions are injected into the model's Python namespace inside the REPL:

| Function | Signature | Description |
|---|---|---|
| `context` | `list[dict]` | Repository packed as `[{"path","content","tokens"}, ...]` — the full codebase |
| `llm_query` | `(prompt, model=None) -> str` | One-shot sub-LLM call (worker model) |
| `llm_query_batched` | `(prompts, model=None) -> list[str]` | Concurrent sub-LLM calls (pool-bounded) |
| `rlm_query` | `(prompt, model=None) -> str` | Recursive child RLM with its own sandbox (depth-capped) |
| `rlm_query_batched` | `(prompts, model=None) -> list[str]` | Concurrent recursive child RLMs |
| `todo` | `(action, **kwargs) -> str` | Task list: `create`/`update`/`list`/`get`/`delete`/`clear` |
| `ask_user_question` | `(questions) -> list[dict]` | Ask the user structured questions (depth 0 only) |
| `SHOW_VARS` | `() -> str` | List currently defined variables & their types |
| `answer` | `dict` | Set `answer["content"]=...; answer["ready"]=True` to finalize |

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---|---|---|
| Smart model | Pi's active model | the root orchestrator |
| Worker model | cheapest available | answers `llm_query` |
| Max recursion depth | `4` | `rlm_query` past this falls back to `llm_query` |
| Max iterations | `30` | turns before the engine finalizes |
| Budget ceiling | none | stops the whole tree when USD spend exceeds this |
| Max consecutive errors | `5` | stops after N consecutive error turns |
| REPL block timeout | `120s` | per-`repl`-block wall-clock (SIGALRM in the worker) |
| Max concurrent sub-calls | `4` | pool size for `*_batched` |
| Orchestrator addendum | on | "delegate, don't solve" guidance |
| Trajectory compaction | on (0.85) | summarize history when it nears the context window |
| `yolo` | off | apply proposed edits immediately, skipping the review popup |
| `askUserQuestion` | on | expose `ask_user_question()` to the model |
| `todo` | on | expose `todo()` to the model |

> **Concurrency note:** each `rlm_query` child spawns its own `python3` worker (~50–150 ms
> cold start). Worst-case concurrent interpreters ≈ `maxConcurrentSubcalls`^(depth−1); at
> defaults (depth 4, conc 4) that's 4³ = 64 in the pathological case. Budget and error
> caps (above) bound total spend regardless of fan-out.

## Telemetry & run logs

- **Run logs** (`runLog`): always-on by default. Each run writes a JSONL trail to `.rlm/runs/`
  (default), capped at `maxRuns` (50). Supports **snapshots** (`sandbox.pkl`) and **resume**
  of interrupted runs via `/rlm-resume`. Snapshots are protected by a per-session `nonce`
  to prevent cross-session replay.
- **MLflow tracing** (`telemetry`): optional. Set `MLFLOW_TRACKING_URI` or configure
  `trackingUri` / `experimentId` in `/rlm-config`. The root run is tagged as an MLflow span
  for trace correlation on resume. The Bearer token comes from the `MLFLOW_TRACKING_TOKEN`
  env var and is **never persisted** to `rlm.json`.

## Security

- **Key isolation**: provider keys live only in TypeScript (`AuthStorage`); the sandbox
  receives prompts and returns text — never keys.
- **Environment sanitization**: sensitive env vars (API keys, tokens) are stripped before the
  worker spawns. The worker cannot read provider credentials from `os.environ`.
- **NOT a security sandbox**: the Python worker exposes `__import__` and `open`. Model-authored
  code can import networking modules, read/write local files, and write protocol-shaped JSON to
  stdout. This tier trusts the root model's code; the stdio protocol isolates provider keys and
  process lifecycle, **not** adversarial code containment. A stronger sandbox (Docker, seccomp)
  can be added later behind a setting without protocol changes.
- **Restricted builtins**: no `eval`/`exec`/`compile`/`input`/`globals`/`locals`; per-block
  SIGALRM timeout + parent watchdog (SIGKILL on hang); budget / token / timeout /
  consecutive-error caps.
- **Trust**: project-local install requires Pi project trust.

## Project layout

```
src/
  sandbox/    worker.py + JSONL stdio driver (PythonSandbox) · protocol.ts · sandbox-manager.ts
  bridge/     model.ts (one-shot completion) · llm-query.ts · rlm-query.ts (recursion)
  core/       engine.ts (the loop) · iteration · limits · answer · compaction · pipeline · types
  prompts/    system + per-turn prompts (ported from the Python reference)
  text/       parsing (repl blocks) · tokens · preview · edits
  state/      agent-tree · events · reads/writes · resume · paths · rows
  tool/       repl-tool · rlm-events · aggregator · propose-edits · emitter-listener
  config/     defaults · settings (rlm.json persistence + validation)
  context/    repomix-based repository packing + caching
  telemetry/  MLflow sink · dispatcher · mlflow-config
  ui/         tree-widget · status · model-picker · config-panel · intro · theme
  commands/   rlm · rlm-config
  mode/       rlm-mode (controller) · input-router
  patch/      apply · popup · index
  util/       errors · concurrency
test/         phase1–phase9 · native-smoke · native-mode · helpers
```

## Tests

Runtime is **Bun** (`bun install`, `bun run …` — never npm/pnpm/yarn).

```bash
bun run test/phase1.ts                   # sandbox: exec, persistence, key isolation, timeout kill
bun run test/phase4.ts                   # recursion depth-cap logic (no tokens)
bun run test/phase5.ts                   # live agent tree rendering (no tokens)
RLM_TEST_LIVE=1 bun run test/phase2.ts   # real llm_query through the sandbox
RLM_TEST_LIVE=1 bun run test/phase3.ts   # real end-to-end /rlm over a file context
RLM_TEST_LIVE=1 bun run test/phase4.ts   # engine solves a 20-doc needle-in-haystack
```

## Background

Modeled on the Python reference [`rlm`](https://github.com/alexzhang13/rlm-minimal) and the
method in the [RLM paper](https://arxiv.org/abs/2512.24601), reimplemented natively for Pi.

If you use this in your research, please cite the original RLM work:

```bibtex
@misc{zhang2026recursivelanguagemodels,
      title={Recursive Language Models},
      author={Alex L. Zhang and Tim Kraska and Omar Khattab},
      year={2026},
      eprint={2512.24601},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2512.24601},
}
```

---

## 中文

# pi-rlm — 为 [Pi](https://github.com/earendil-works) 编程代理提供的递归语言模型 (Recursive Language Models)

<div align="center">

**递归语言模型 (RLMs)** 作为 Pi 扩展原生实现 ——
无需额外服务器，无需 Docker，无需 socket。

</div>

---

**递归语言模型 (RLM)** 是一种与任务无关的推理范式，其中根语言模型通过对输入进行*编程式*的检查、分解并**递归调用自身**，从而在近乎无限的上下文中进行编排。RLM 将典型的 `llm.completion(prompt, model)` 调用替换为 `rlm.completion(prompt, model)` 调用：提示词/上下文作为 REPL 环境中的一个变量进行卸载，模型与其进行交互，并且模型可以将子 LLM 和子 RLM 调用作为代码中的普通函数启动。

这是对 [CodeAct](https://arxiv.org/abs/2402.01030) 风格框架的一种尝试 —— 每个语言模型都能访问代码环境，子 (R)LM 调用是函数，而上下文/提示词是代码中的对象 —— 从而脱离了 JSON 工具调用 (tool-calling) 标准。以此方式构建的系统*本身*就是一个依赖于递归子 LLM 调用的语言模型，因此得名。

`pi-rlm` 将该范式**原生引入 Pi**：

- **根编排器**模型逐轮驱动一个**持久化的 Python REPL**。
- 长上下文工作通过 `llm_query` / `llm_query_batched` **委派**给廉价的工作模型。
- 困难的子问题通过 `rlm_query` **递归**到子 RLM 中（设有深度限制）。
- 所有内容均**在进程内**运行 —— 唯一的外部进程是一个本地的 `python3` worker。

> 这是 RLM 方法的 Pi 插件重新实现（参见 [RLM 论文](https://arxiv.org/abs/2512.24601)
> 和 [Python `rlm` 库](https://github.com/alexzhang13/rlm-minimal)）。它**不是**那个 Python 库。

## 工作原理

```
pi 进程 (TypeScript)
 ├─ /rlm  ──► 引擎逐轮驱动 SMART (根) 模型 (编写 ```repl``` Python)
 │             │  每轮：解析 repl 块 ──► 在沙箱中运行 ──► 将 stdout 反馈回去
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER 模型 (serverless, 进程内)
 │            rlm_query ──► 递归子 RLM (自有沙箱), 设有深度限制
 ├─ AgentTree ──► 编辑器上方的实时 agent/subagent 树 (角色, 深度, 成本, token)
 └─ PythonSandbox ── `python3 worker.py` ──[基于 stdio 的 JSONL, 双向]── 持久化 REPL
```

- **无需服务器，无需 socket，无需 Docker。** 唯一的外部进程是一个本地 `python3` 沙箱。
  当沙箱代码调用 `llm_query` 时，worker 在 stdout 上写入请求并在 stdin 上阻塞；
  Pi 在进程内提供服务并将回复写回。**供应商 API 密钥绝不会进入沙箱。**
- 沙箱公开了 `context`, `llm_query`, `llm_query_batched`, `rlm_query`,
  `rlm_query_batched`, `SHOW_VARS()`, `todo()`, `ask_user_question()` 以及一个 `answer` 字典。
  模型通过设置 `answer["ready"] = True` 来提交最终结果。

## 安装

`pi-rlm` 是一个 Pi 包。Pi 提供了 `@earendil-works/pi-*` 和 `typebox` peer
依赖；请**不要**在该包中安装它们的独立副本。要求 `PATH` 中有 `python3` (仅限标准库)。

开发时的推荐本地安装方式：

```bash
pi install /path/to/this-repo/pi-plugin/rlm
```

已发布的 npm 包安装方式：

```bash
npm publish                       # 例如 as @<you>/pi-rlm
pi install npm:@<you>/pi-rlm
```

> **Git 安装**要求包清单位于安装的仓库根目录下。
> 对于像这样一个 monorepo 子目录，请优先使用上述的本地路径或 npm 流程。

如果您之前直接复制了扩展文件夹，请将其删除，以免遮蔽 (shadow) 该包：

```bash
rm -rf ~/.pi/agent/extensions/rlm
```

然后运行 `/reload` 或重启 Pi。使用 `pi list` 验证该包是否出现在
`settings.packages` 中，并检查 `/rlm`, `/rlm-config` 和 `/rlm-stop` 是否出现在 **[Extensions]** 下。

## 命令

| 命令 | 快捷键 | 描述 |
|---|---|---|
| `/rlm` | `Ctrl+Shift+R` | 切换持久化 RLM 模式 (通过 RLM 引擎路由普通提示词) |
| `/rlm-stop` | | 终止正在运行的任务 |
| `/rlm-config` | | 选择 smart + worker 模型并调整运行设置 |
| `/rlm-resume` | | 恢复被中断的任务 (默认 `@latest`) |
| `/rlm-runs` | | 列出最近的任务 |
| `/rlm-help` | | 显示启动指南和速查表 |

在任务激活期间，一个**实时树**会显示根编排器和每个子 LLM /
递归子节点的状态、模型、成本、token 和持续时间。最终答案将以 markdown 形式发布
到聊天中；任何代码修改将作为 diff 收集并通过弹出窗口进行审核 (除非开启了 `yolo`)。

## 沙箱 API

这些函数被注入到 REPL 内部模型的 Python 命名空间中：

| 函数 | 签名 | 描述 |
|---|---|---|
| `context` | `list[dict]` | 打包为 `[{"path","content","tokens"}, ...]` 的仓库 —— 完整的代码库 |
| `llm_query` | `(prompt, model=None) -> str` | 单次子 LLM 调用 (worker 模型) |
| `llm_query_batched` | `(prompts, model=None) -> list[str]` | 并发子 LLM 调用 (池上限) |
| `rlm_query` | `(prompt, model=None) -> str` | 具有自有沙箱的递归子 RLM (设有深度限制) |
| `rlm_query_batched` | `(prompts, model=None) -> list[str]` | 并发递归子 RLM |
| `todo` | `(action, **kwargs) -> str` | 任务列表：`create`/`update`/`list`/`get`/`delete`/`clear` |
| `ask_user_question` | `(questions) -> list[dict]` | 向用户提出结构化问题 (仅限深度 0) |
| `SHOW_VARS` | `() -> str` | 列出当前定义的变量及其类型 |
| `answer` | `dict` | 设置 `answer["content"]=...; answer["ready"]=True` 以结束 |

## 设置 (`/rlm-config`)

| 设置 | 默认值 | 含义 |
|---|---|---|
| Smart model | Pi 的当前活动模型 | 根编排器 |
| Worker model | 最便宜的可用模型 | 响应 `llm_query` |
| Max recursion depth | `4` | 超过此深度的 `rlm_query` 将回退到 `llm_query` |
| Max iterations | `30` | 引擎完成前的最大轮数 |
| Budget ceiling | none | 当美元支出超过此值时停止整个树 |
| Max consecutive errors | `5` | 在 N 轮连续错误后停止 |
| REPL block timeout | `120s` | 每个 `repl` 块的墙上时钟时间 (worker 中的 SIGALRM) |
| Max concurrent sub-calls | `4` | `*_batched` 的池大小 |
| Orchestrator addendum | on | “委派，而非自行解决”的引导 |
| Trajectory compaction | on (0.85) | 当历史记录接近上下文窗口时进行总结 |
| `yolo` | off | 立即应用建议的修改，跳过审核弹出窗 |
| `askUserQuestion` | on | 向模型公开 `ask_user_question()` |
| `todo` | on | 向模型公开 `todo()` |

> **并发注意：** 每个 `rlm_query` 子节点都会启动自己的 `python3` worker (冷启动约 50–150 毫秒)。
> 最坏情况下的并发解释器数量 ≈ `maxConcurrentSubcalls`^(depth−1)；在
> 默认设置下 (深度 4, 并发 4)，极端情况下为 4³ = 64。预算和错误
> 上限 (见上文) 无论扇出 (fan-out) 如何都会限制总支出。

## 遥测与运行日志

- **运行日志** (`runLog`)：默认始终开启。每次运行将 JSONL 轨迹写入 `.rlm/runs/`
  (默认)，上限为 `maxRuns` (50)。支持通过 `/rlm-resume` 进行**快照** (`sandbox.pkl`) 和**恢复**
  被中断的任务。快照受每个会话的 `nonce` 保护，以防止跨会话重放。
- **MLflow 追踪** (`telemetry`)：可选。设置 `MLFLOW_TRACKING_URI` 或在
  `/rlm-config` 中配置 `trackingUri` / `experimentId`。根运行被标记为 MLflow span
  以便在恢复时进行追踪关联。Bearer 令牌来自 `MLFLOW_TRACKING_TOKEN`
  环境变量，且**绝不会**持久化到 `rlm.json`。

## 安全性

- **密钥隔离**：供应商密钥仅存在于 TypeScript (`AuthStorage`) 中；沙箱
  接收提示词并返回文本 —— 绝不接触密钥。
- **环境清理**：在 worker 启动前会剥离敏感环境变量 (API 密钥, token)。
  worker 无法从 `os.environ` 读取供应商凭据。
- **并非安全沙箱**：Python worker 公开了 `__import__` 和 `open`。模型编写的
  代码可以导入网络模块、读写本地文件，并向 stdout 写入符合协议格式的 JSON。
  此层级信任根模型的代码；stdio 协议隔离的是供应商密钥和
  进程生命周期，**而非**对抗性代码的隔离。以后可以在不改变协议的情况下，
  通过设置添加更强的沙箱 (Docker, seccomp)。
- **限制内置函数**：禁用 `eval`/`exec`/`compile`/`input`/`globals`/`locals`；每块
  SIGALRM 超时 + 父进程监视器 (挂起时 SIGKILL)；预算 / token / 超时 /
  连续错误上限。
- **信任**：本地安装需要 Pi 项目信任。

## 项目布局

```
src/
  sandbox/    worker.py + JSONL stdio driver (PythonSandbox) · protocol.ts · sandbox-manager.ts
  bridge/     model.ts (one-shot completion) · llm-query.ts · rlm-query.ts (recursion)
  core/       engine.ts (the loop) · iteration · limits · answer · compaction · pipeline · types
  prompts/    system + per-turn prompts (ported from the Python reference)
  text/       parsing (repl blocks) · tokens · preview · edits
  state/      agent-tree · events · reads/writes · resume · paths · rows
  tool/       repl-tool · rlm-events · aggregator · propose-edits · emitter-listener
  config/     defaults · settings (rlm.json persistence + validation)
  context/    repomix-based repository packing + caching
  telemetry/  MLflow sink · dispatcher · mlflow-config
  ui/         tree-widget · status · model-picker · config-panel · intro · theme
  commands/   rlm · rlm-config
  mode/       rlm-mode (controller) · input-router
  patch/      apply · popup · index
  util/       errors · concurrency
test/         phase1–phase9 · native-smoke · native-mode · helpers
```

## 测试

运行时为 **Bun** (`bun install`, `bun run …` —— 绝不要使用 npm/pnpm/yarn)。

```bash
bun run test/phase1.ts                   # 沙箱：执行, 持久化, 密钥隔离, 超时终止
bun run test/phase4.ts                   # 递归深度限制逻辑 (不消耗 token)
bun run test/phase5.ts                   # 实时 agent 树渲染 (不消耗 token)
RLM_TEST_LIVE=1 bun run test/phase2.ts   # 通过沙箱进行真实的 llm_query
RLM_TEST_LIVE=1 bun run test/phase3.ts   # 在文件上下文中进行真实的端到端 /rlm 运行
RLM_TEST_LIVE=1 bun run test/phase4.ts   # 引擎解决 20 个文档的“大海捞针”测试
```

## 背景

基于 Python 参考实现 [`rlm`](https://github.com/alexzhang13/rlm-minimal) 和
[RLM 论文](https://arxiv.org/abs/2512.24601) 中的方法，为 Pi 原生重新实现。

如果您在研究中使用此项目，请引用原始 RLM 工作：

```bibtex
@misc{zhang2026recursivelanguagemodels,
      title={Recursive Language Models},
      author={Alex L. Zhang and Tim Kraska and Omar Khattab},
      year={2026},
      eprint={2512.24601},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2512.24601},
}
```

---

## Русский

# pi-rlm — рекурсивные языковые модели для кодинг-агента [Pi](https://github.com/earendil-works)

<div align="center">

**Рекурсивные языковые модели (RLMs)**, реализованные нативно как расширение Pi —
без дополнительных серверов, Docker или сокетов.

</div>

---

**Рекурсивная языковая модель (RLM)** — это универсальная (task-agnostic) парадигма инференса, в которой корневая языковая модель управляет почти бесконечным контекстом, *программно* исследуя, декомпозируя и **рекурсивно вызывая саму себя** для обработки входных данных. RLM заменяют канонический вызов `llm.completion(prompt, model)` на вызов `rlm.completion(prompt, model)`: промпт/контекст передается как переменная в среде REPL, с которой взаимодействует модель, а модель может запускать вызовы sub-LLM и sub-RLM как обычные функции в коде.

Это ставка на архитектуру в стиле [CodeAct](https://arxiv.org/abs/2402.01030): каждая языковая модель получает доступ к среде выполнения кода, вызовы sub-(R)LM являются функциями, а контекст/промпты — объектами в коде, что является уходом от стандарта вызова инструментов через JSON. Система, построенная таким образом, *сама по себе* является языковой моделью, которая полагается на рекурсивные вызовы sub-LLM, отсюда и название.

`pi-rlm` переносит эту парадигму **нативно в Pi**:

- **Модель-оркестратор** управляет постоянным Python REPL пошагово.
- Работа с длинным контекстом **делегируется** дешевым worker-моделям через `llm_query` / `llm_query_batched`.
- Сложные подзадачи **рекурсивно** передаются в дочерние RLM через `rlm_query` (с ограничением глубины).
- Все работает **in-process** — единственным внешним процессом является локальный worker `python3`.

> This is a Pi-plugin reimplementation of the RLM method (see the [RLM paper](https://arxiv.org/abs/2512.24601)
> and the [Python `rlm` library](https://github.com/alexzhang13/rlm-minimal)). It is **not** the Python library.

## Как это работает

```
pi process (TypeScript)
 ├─ /rlm  ──► движок управляет SMART (корневой) моделью пошагово (пишет ```repl``` Python)
 │             │  каждый шаг: парсинг repl-блоков ──► запуск в песочнице ──► возврат stdout
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER модель (serverless, in-process)
 │            rlm_query ──► рекурсивный дочерний RLM (с собственной песочницей), с ограничением глубины
 ├─ AgentTree ──► живое дерево агентов/субагентов над редактором (роли, глубина, стоимость, токены)
 └─ PythonSandbox ── `python3 worker.py` ──[JSONL over stdio, bidirectional]── постоянный REPL
```

- **Никаких серверов, сокетов или Docker.** Единственным внешним процессом является локальная песочница `python3`. Когда код в песочнице вызывает `llm_query`, worker пишет запрос в stdout и блокируется на stdin; Pi обрабатывает его внутри своего процесса и записывает ответ обратно. **API-ключи провайдеров никогда не попадают в песочницу.**
- Песочница предоставляет `context`, `llm_query`, `llm_query_batched`, `rlm_query`,
  `rlm_query_batched`, `SHOW_VARS()`, `todo()`, `ask_user_question()` и словарь `answer`.
  Модель отправляет окончательный результат, устанавливая `answer["ready"] = True`.

## Установка

`pi-rlm` — это пакет Pi. Pi предоставляет peer-зависимости `@earendil-works/pi-*` и `typebox`; **не** устанавливайте их отдельную копию в этот пакет. Требуется `python3` в `PATH` (только стандартная библиотека).

Рекомендуемая локальная установка при разработке:

```bash
pi install /path/to/this-repo/pi-plugin/rlm
```

Установка опубликованного npm-пакета:

```bash
npm publish                       # например, как @<you>/pi-rlm
pi install npm:@<you>/pi-rlm
```

> **Установка через Git** требует, чтобы манифест пакета находился в корне устанавливаемого репозитория. Для поддиректорий монорепозитория, таких как эта, предпочтительнее использовать локальный путь или npm, как указано выше.

Если вы ранее копировали папку расширения напрямую, удалите ее, чтобы она не перекрывала пакет:

```bash
rm -rf ~/.pi/agent/extensions/rlm
```

Затем выполните `/reload` или перезапустите Pi. Убедитесь с помощью `pi list`, что пакет появился в `settings.packages`, и проверьте, что `/rlm`, `/rlm-config` и `/rlm-stop` отображаются в разделе **[Extensions]**.

## Команды

| Команда | Горячая клавиша | Описание |
|---|---|---|
| `/rlm` | `Ctrl+Shift+R` | Переключить постоянный режим RLM (направлять обычные промпты через движок RLM) |
| `/rlm-stop` | | Прервать текущий запуск |
| `/rlm-config` | | Выбрать smart- и worker-модели и настроить параметры запуска |
| `/rlm-resume` | | Возобновить прерванный запуск (по умолчанию `@latest`) |
| `/rlm-runs` | | Список последних запусков |
| `/rlm-help` | | Показать руководство по запуску и шпаргалку |

Пока запуск активен, **живое дерево** отображает корневой оркестратор и каждый sub-LLM / рекурсивный дочерний элемент со статусом, моделью, стоимостью, токенами и длительностью. Окончательный ответ публикуется в чате в формате markdown; любые правки кода собираются в виде диффов и проверяются через всплывающее окно (если не включен `yolo`).

## Sandbox API

Эти функции внедряются в пространство имен Python модели внутри REPL:

| Функция | Сигнатура | Описание |
|---|---|---|
| `context` | `list[dict]` | Репозиторий, упакованный как `[{"path","content","tokens"}, ...]` — вся кодовая база |
| `llm_query` | `(prompt, model=None) -> str` | Одноразовый вызов sub-LLM (worker-модель) |
| `llm_query_batched` | `(prompts, model=None) -> list[str]` | Параллельные вызовы sub-LLM (с ограничением пула) |
| `rlm_query` | `(prompt, model=None) -> str` | Рекурсивный дочерний RLM со своей песочницей (с ограничением глубины) |
| `rlm_query_batched` | `(prompts, model=None) -> list[str]` | Параллельные рекурсивные дочерние RLM |
| `todo` | `(action, **kwargs) -> str` | Список задач: `create`/`update`/`list`/`get`/`delete`/`clear` |
| `ask_user_question` | `(questions) -> list[dict]` | Задать пользователю структурированные вопросы (только на глубине 0) |
| `SHOW_VARS` | `() -> str` | Список текущих переменных и их типов |
| `answer` | `dict` | Установите `answer["content"]=...; answer["ready"]=True` для завершения |

## Настройки (`/rlm-config`)

| Настройка | По умолчанию | Значение |
|---|---|---|
| Smart model | Активная модель Pi | корневой оркестратор |
| Worker model | Самая дешевая доступная | отвечает на `llm_query` |
| Max recursion depth | `4` | при превышении этой глубины `rlm_query` переключается на `llm_query` |
| Max iterations | `30` | количество шагов до завершения работы движка |
| Budget ceiling | нет | остановка всего дерева, когда затраты в USD превышают этот лимит |
| Max consecutive errors | `5` | остановка после N последовательных шагов с ошибками |
| REPL block timeout | `120s` | реальное время на один `repl`-блок (SIGALRM в worker) |
| Max concurrent sub-calls | `4` | размер пула для `*_batched` |
| Orchestrator addendum | вкл | инструкция «делегируй, а не решай сам» |
| Trajectory compaction | вкл (0.85) | суммаризация истории при приближении к лимиту окна контекста |
| `yolo` | выкл | применять предлагаемые правки немедленно, пропуская окно подтверждения |
| `askUserQuestion` | вкл | предоставить доступ к `ask_user_question()` для модели |
| `todo` | вкл | предоставить доступ к `todo()` для модели |

> **Примечание по параллелизму:** каждый дочерний `rlm_query` запускает собственного worker `python3` (~50–150 мс «холодного старта»). В худшем случае количество параллельных интерпретаторов ≈ `maxConcurrentSubcalls`^(depth−1); при настройках по умолчанию (глубина 4, параллелизм 4) это 4³ = 64 в патологическом случае. Лимиты бюджета и ошибок (см. выше) ограничивают общие затраты независимо от степени разветвления.

## Телеметрия и логи запусков

- **Логи запусков** (`runLog`): включены по умолчанию. Каждый запуск записывает след в формате JSONL в `.rlm/runs/` (по умолчанию) с ограничением `maxRuns` (50). Поддерживает **снимки** (`sandbox.pkl`) и **возобновление** прерванных запусков через `/rlm-resume`. Снимки защищены сессионным `nonce` для предотвращения повторов между сессиями.
- **Трассировка MLflow** (`telemetry`): опционально. Установите `MLFLOW_TRACKING_URI` или настройте `trackingUri` / `experimentId` в `/rlm-config`. Корневой запуск помечается как span MLflow для корреляции трасс при возобновлении. Bearer-токен берется из переменной окружения `MLFLOW_TRACKING_TOKEN` и **никогда не сохраняется** в `rlm.json`.

## Безопасность

- **Изоляция ключей**: ключи провайдеров хранятся только в TypeScript (`AuthStorage`); песочница получает промпты и возвращает текст, но никогда не получает ключи.
- **Очистка окружения**: чувствительные переменные окружения (API-ключи, токены) удаляются перед запуском worker. Worker не может прочитать учетные данные провайдеров из `os.environ`.
- **НЕ является защищенной песочницей**: Python-worker предоставляет доступ к `__import__` и `open`. Код, написанный моделью, может импортировать сетевые модули, читать/записывать локальные файлы и писать JSON-данные протокола в stdout. Этот уровень доверяет коду корневой модели; протокол stdio изолирует ключи провайдеров и жизненный цикл процесса, а **не** ограничивает вредоносный код. Более строгая песочница (Docker, seccomp) может быть добавлена позже через настройки без изменения протокола.
- **Ограниченные встроенные функции**: запрещены `eval`/`exec`/`compile`/`input`/`globals`/`locals`; тайм-аут SIGALRM для каждого блока + родительский watchdog (SIGKILL при зависании); лимиты по бюджету / токенам / времени / количеству последовательных ошибок.
- **Доверие**: локальная установка в проект требует доверия к проекту Pi.

## Структура проекта

```
src/
  sandbox/    worker.py + JSONL stdio driver (PythonSandbox) · protocol.ts · sandbox-manager.ts
  bridge/     model.ts (одноразовое завершение) · llm-query.ts · rlm-query.ts (рекурсия)
  core/       engine.ts (цикл) · iteration · limits · answer · compaction · pipeline · types
  prompts/    системные промпты и промпты для каждого шага (перенесены из Python-референса)
  text/       парсинг (repl-блоки) · токены · превью · правки
  state/      дерево-агентов · события · чтения/записи · возобновление · пути · строки
  tool/       repl-tool · rlm-events · агрегатор · предложение-правок · emitter-listener
  config/     значения по умолчанию · настройки (сохранение и валидация rlm.json)
  context/    упаковка репозитория на базе repomix + кеширование
  telemetry/  MLflow sink · диспетчер · mlflow-config
  ui/         виджет-дерева · статус · выбор-модели · панель-конфигурации · вступление · тема
  commands/   rlm · rlm-config
  mode/       rlm-mode (контроллер) · маршрутизатор-ввода
  patch/      применение · всплывающее-окно · индекс
  util/       ошибки · параллелизм
test/         фазы 1–9 · native-smoke · native-mode · помощники
```

## Тесты

Среда выполнения — **Bun** (`bun install`, `bun run …` — никогда не используйте npm/pnpm/yarn).

```bash
bun run test/phase1.ts                   # sandbox: exec, persistence, key isolation, timeout kill
bun run test/phase4.ts                   # recursion depth-cap logic (no tokens)
bun run test/phase5.ts                   # live agent tree rendering (no tokens)
RLM_TEST_LIVE=1 bun run test/phase2.ts   # real llm_query through the sandbox
RLM_TEST_LIVE=1 bun run test/phase3.ts   # real end-to-end /rlm over a file context
RLM_TEST_LIVE=1 bun run test/phase4.ts   # engine solves a 20-doc needle-in-haystack
```

## Общая информация

Реализовано на основе эталонного проекта [`rlm`](https://github.com/alexzhang13/rlm-minimal) на Python и метода из [статьи RLM](https://arxiv.org/abs/2512.24601), с нативной переработкой для Pi.

Если вы используете этот проект в своих исследованиях, пожалуйста, сошлитесь на оригинальную работу RLM:

```bibtex
@misc{zhang2026recursivelanguagemodels,
      title={Recursive Language Models},
      author={Alex L. Zhang and Tim Kraska and Omar Khattab},
      year={2026},
      eprint={2512.24601},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2512.24601},
}
```
