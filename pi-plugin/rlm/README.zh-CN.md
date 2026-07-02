<div align="center">

<img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" alt="pi-rlm">

</div>

<div align="center">

<sub>
<a href="README.md">English</a> &nbsp;·&nbsp; **中文** &nbsp;·&nbsp; <a href="README.ru.md">Русский</a>
</sub>

</div>

---

# pi-rlm — 为 [Pi](https://github.com/earendil-works) 编程代理提供的递归语言模型 (Recursive Language Models)

<div align="center">

**递归语言模型 (RLMs)** 作为 Pi 扩展原生实现 ——
完全本地。

</div>

---

**递归语言模型 (RLM)** 是一种与任务无关的推理范式，其中根语言模型通过对输入进行*编程式*的检查、分解并**递归调用自身**，从而在近乎无限的上下文中进行编排。RLM 将典型的 `llm.completion(prompt, model)` 调用替换为 `rlm.completion(prompt, model)` 调用：提示词/上下文作为 REPL 环境中的一个变量进行卸载，模型与其进行交互，并且模型可以将子 LLM 和子 RLM 调用作为代码中的普通函数启动。

这是对 [CodeAct](https://arxiv.org/abs/2402.01030) 风格框架的一种尝试 —— 每个语言模型都能访问代码环境，子 (R)LM 调用是函数，而上下文/提示词是代码中的对象 —— 从而脱离了 JSON 工具调用 (tool-calling) 标准。以此方式构建的系统*本身*就是一个依赖于递归子 LLM 调用的语言模型，因此得名。

`pi-rlm` 将该范式**原生引入 Pi**：

- **根编排器**模型逐轮驱动一个**持久化的 Python REPL**。
- 长上下文工作通过 `llm_query` / `llm_query_batched` **委派**给廉价的工作模型。
- 困难的子问题通过 `rlm_query` **递归**到子 RLM 中（设有深度限制）。
- 所有内容均**在进程内**运行 —— 唯一的外部进程是一个本地的 `python3` worker。

> 这是 RLM 方法的 Pi 插件重新实现（参见 [RLM 论文](https://arxiv.org/abs/2512.24601)）。
> 它**不是**那个 Python 库。

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
| `llm_query_chunked` | `(text, prompt, model=None) -> list[str]` | 将大文本拆分为不超过上限的块并通过子 LLM 处理 |
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

## 运行日志

- **运行日志** (`runLog`)：默认始终开启。每次运行将 JSONL 轨迹写入 `.rlm/runs/`
  (默认)，上限为 `maxRuns` (50)。支持通过 `/rlm-resume` 进行**快照** (`sandbox.pkl`) 和**恢复**
  被中断的任务。快照受每个会话的 `nonce` 保护，以防止跨会话重放。

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
  state/      reads/writes · resume · paths · rows
  tool/       repl-tool · rlm-events · aggregator · propose-edits · emitter-listener
  config/     defaults · settings (rlm.json persistence + validation)
  context/    repomix-based repository packing + caching
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
