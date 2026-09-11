<div align="center">

<sub>
<a href="README.md">English</a> &nbsp;·&nbsp; <b>中文</b> &nbsp;·&nbsp; <a href="README.ru.md">Русский</a>
</sub>

</div>

---

# rlm.pi PI plugin

> pi-rlm — 大上下文，廉价模型：为 Pi 提供的递归语言模型 (RLM)

## 安装

```bash
pi install npm:@hicaru/pi-rlm
```

以后要移除：

```bash
pi uninstall npm:@hicaru/pi-rlm
```

然后在 Pi 中运行 `/reload` —— `/rlm`、`/rlm-config` 和 `/rlm-stop` 会出现在 **[Extensions]** 下。使用 `Ctrl+Shift+R` 或 `/rlm` 切换。

<p align="center">
  <img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" width="100%" alt="rlm.pi — OOLONG 基准测试结果">
</p>

## 什么是 pi-rlm？

一个把 Pi 会话变成**递归语言模型 (RLM)** 的插件：不必把庞大的文档塞进提示词，上下文
驻留在 Python REPL 中，由你最好的模型编排 —— 检索、分解，并把叶子读取递归地委派给
廉价的工作模型。同一个 Pi 会话、同样的工具、同样的密钥 —— 打开 `/rlm` 即可。
方法基于 [RLM 论文](https://arxiv.org/abs/2512.24601)；详见下方的**工作原理**。

## 基准测试

**OOLONG (oolong-synth)** —— paper 级长上下文套件；取每个模型最新的日志，每任务成本
来自真实 `costUsd`（旧日志按 OpenRouter 牌价估算）：

**本轮面板** —— `glm-4.7` · `qwen3.8-27b` · `mercury-2.5`（最新日志见
`bench/runs/*.jsonl`，历史表格待本轮跑完后更新）：

| 模型 | 得分 | 每任务成本 |
|------|------|------------|
| `zai/glm-4.7` | **83%** | $0.0000 * |
| `qwen/qwen3.8-27b` | 49% | $0.1038 |
| `inception/mercury-2.5` | 38% | $0.0052 |

\* glm-4.7 走 Z.ai coding 端点 —— 按订阅计费，引擎无单价，`costUsd` 保持 $0。

逐任务原始数据（正确性、召回率、延迟、token、成本）位于 `bench/runs/*.jsonl`
—— 每个任务一行 JSONL，作为历史记录提交。

### 运行基准测试

```bash
export OPENROUTER_API_KEY=sk-or-...        # openrouter/* 模型必需
export ZAI_API_KEY=...                     # zai/* 模型必需（coding 端点）

bun run bench                              # oolong 套件，默认模型（qwen3.8-27b）
bun run bench --model zai/glm-4.7
bun run bench --model openrouter/inception/mercury-2.5
bun run bench --list                       # 仅列出任务，无需引擎和密钥
```

只有一个套件（`oolong`）。

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
  `rlm_query_batched`, `SHOW_VARS()`, `ask_user_question()` 以及一个 `answer` 字典。
  模型通过设置 `answer["ready"] = True` 来提交最终结果。

## 从源码安装（开发）

`pi-rlm` 是一个 Pi 包。Pi 提供了 `@earendil-works/pi-*` 和 `typebox` peer
依赖；请**不要**在该包中安装它们的独立副本。要求 `PATH` 中有 `python3` (仅限标准库)。

开发时的本地安装方式：

```bash
pi install /path/to/this-repo/pi-plugin/rlm
```

> **Git 安装**要求包清单位于安装的仓库根目录下。
> 对于像这样一个 monorepo 子目录，请优先使用上述的本地路径流程。

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

在任务激活期间，一个**实时树**会显示根编排器和每个子 LLM /
递归子节点的状态、模型、成本、token 和持续时间。最终答案将以 markdown 形式发布
到聊天中；任何代码修改将作为 diff 收集并通过弹出窗口进行审核 (除非开启了 `yolo`)。

## 沙箱 API

这些函数被注入到 REPL 内部模型的 Python 命名空间中：

| 函数 | 签名 | 描述 |
|---|---|---|
| `context` | `list[dict]` | 打包为 `[{"path","content","tokens"}, ...]` 的仓库 —— 完整的代码库 |
| `llm_query` | `(prompt) -> str` | 单次子 LLM 调用（配置的 RLM LLM） |
| `llm_query_batched` | `(prompts) -> list[str]` | 并发子 LLM 调用 (池上限) |
| `rlm_query` | `(prompt, paths=None) -> str` | 具有自有沙箱的递归子 RLM (设有深度限制)。继承父级的 `context`；`paths` 按前缀缩小范围 |
| `rlm_query_batched` | `(prompts, paths=None) -> list[str]` | 并发递归子 RLM，共享同一个 `paths` 切片 |
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

> **并发注意：** 每个 `rlm_query` 子节点都会启动自己的 `python3` worker (冷启动约 50–150 毫秒)。
> 最坏情况下的并发解释器数量 ≈ `maxConcurrentSubcalls`^(depth−1)；在
> 默认设置下 (深度 4, 并发 4)，极端情况下为 4³ = 64。预算和错误
> 上限 (见上文) 无论扇出 (fan-out) 如何都会限制总支出。

## 遥测与运行日志

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
  sandbox/    py/ (worker.py · guards · retrieval · tasks) · sandbox.ts · interrupts · protocol · sandbox-manager · context-file
  bridge/     model.ts (single completion) · subcall-handlers.ts (the one llm/rlm impl) · ask-user · library
  core/       engine.ts (the loop) · iteration · limits · resource-limits · answer · compaction · history · types
  prompts/    glossary (shared REPL vocabulary) · system (headless) · native · user
  text/       parsing (repl blocks) · tokens · preview
  tool/       repl-tool · repl-result · repl-render · rlm-tool · rlm-events · rlm-aggregator · subcall-store · background-tasks
  config/     defaults · settings (rlm.json persistence + validation)
  context/    native walker + anydoc document conversion + add_context
  ui/         status · model-picker · config-panel · intro · theme
  commands/   rlm · rlm-config
  mode/       rlm-mode (controller) · worker-model (cheapest pick) · native-guards
  util/       errors · concurrency · trace
test/         phase suites · native-smoke · native-mode · helpers
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

基于 [RLM 论文](https://arxiv.org/abs/2512.24601) 中的方法，为 Pi 原生重新实现。

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
