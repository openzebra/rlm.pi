<div align="center">

# rlm.pi

**递归语言模型（RLM）for Pi — 百万级上下文，廉价模型。**

把 <b>Pi</b> 和 <b>oh-my-pi</b> 变成研究智能体：面对几百页的文档，它不是"读进去"，
而是在 Python REPL 里<b>检索</b>——由你最强的模型指挥一支廉价的 worker 大军。

<p>
<a href="https://www.npmjs.com/package/@hicaru/pi-rlm"><img src="https://img.shields.io/npm/v/@hicaru/pi-rlm?color=cb3837&label=npm" alt="npm" /></a>
<a href="https://github.com/openzebra/rlm.pi/actions"><img src="https://img.shields.io/badge/OOLONG-91.7%25-brightgreen" alt="OOLONG 91.7%" /></a>
<a href="https://arxiv.org/abs/2512.24601"><img src="https://img.shields.io/badge/arXiv-2512.24601-b31b1b" alt="RLM paper" /></a>
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
</p>

<img src="assets/hero.png" width="92%" alt="rlm.pi — OOLONG 基准测试结果" />

<sub><a href="README.md">English</a> · <b>中文</b> · <a href="README.ru.md">Русский</a></sub>

</div>

## 快速开始

```bash
pi install npm:@hicaru/pi-rlm        # Pi
omp plugin install @hicaru/pi-rlm    # oh-my-pi
```

然后执行 `/reload`（或重启）。确认 `/rlm`、`/rlm-config`、`/rlm-stop` 出现在
**[Extensions]** 下，用 `Ctrl+Shift+R` 或 `/rlm` 开关——普通提示词现在会路由进
RLM 引擎。

| | 安装 | 升级 | 卸载 |
|---|---|---|---|
| **Pi** | `pi install npm:@hicaru/pi-rlm` | `pi install npm:@hicaru/pi-rlm --force` | `pi uninstall npm:@hicaru/pi-rlm` |
| **oh-my-pi** | `omp plugin install @hicaru/pi-rlm` | `omp plugin install @hicaru/pi-rlm --force` | `omp plugin uninstall @hicaru/pi-rlm` |

## 核心思想

上下文不再塞进提示词，而是**活在沙箱里**——文件、PDF、仓库、会话日志——模型只看到
一个索引。每一步都是一次状态转移：

```
A_t = (P, Σ_t, O_t)          固定提示词 + 执行状态 Σ_t + 工具面
ΔΣ_t = μ(A_t)                模型输出 repl() 补丁，而不是散文
V(ΔΣ_t, Σ_t)                 确定性验证器——没有崩溃路径
Σ_{t+1} = Σ_t ⊕ ΔΣ_t         深合并，null = 删除（论文 §5.7）
```

聪明的模型负责指挥（`P`）；廉价的 worker 负责阅读（`llm_query`、`rlm_query`）；
困难的子问题递归成子 RLM——有深度上限、预算约束，每个子 RLM 零 token 成本继承完整
沙箱。运行跨聊天轮次持久化；持久进度以 `Σ` 增量提交，每一步都经过同一验证阶梯。
原生会话免费获得 **Root Σ** 层：被省略的轮次折叠进会话存档，`/compact` 变成确定性
结构摘要，技能库 `Ξ` 把项目事实重排进每一次提示词。

## 基准测试

完整 **OOLONG** 套件（oolong-synth，24 题，上下文最长 128K token），每个模型取最新
一次 journal，成本来自真实 `costUsd`：

| 模型 | OOLONG | 平均 token/题 | 成本/题 |
|---|---|---|---|
| `zai/glm-4.7` | **91.7%** (22/24) | ~36k | ~$0.00 \* |
| `openrouter/qwen/qwen3.8-27b` | 49% | ~36k | $0.10 |
| `openrouter/inception/mercury-2.5` | 38% | ~36k | $0.005 |

\* Z.ai coding-plan 端点——订阅计费，所以 `costUsd` 保持 $0。

在 [RLM 论文](https://arxiv.org/abs/2512.24601)中，GPT-5-mini 以 RLM 方式驱动在
OOLONG 上超过 GPT-o3——递归胜过原始上下文，价格只是零头。

逐题原始数据在 [`bench/runs/*.jsonl`](bench/runs/)。复现：

```bash
export OPENROUTER_API_KEY=sk-or-...    # zai/* 用 ZAI_API_KEY
bun run bench --model zai/glm-4.7 --oolong-max-cl 65536 --oolong-limit 24
```

## 你能得到什么

| | pi-rlm 提供 |
|---|---|
| **研究** | 对仓库、PDF、日志做 map-reduce——worker 阅读，你的模型思考。 |
| **大上下文** | 沙箱零提示词成本装下全部；模型只看到索引。 |
| **省 token** | worker 自动选最便宜的可用模型；阅读永不触碰你的主力模型。 |
| **长任务** | 目标跨轮次循环，带深度上限、预算和错误限额——回来时答案已经写好。 |
| **是插件，不是智能体** | 住在 Pi/omp 里：你的主题、工具、密钥、肌肉记忆。`/rlm` 一键开关。 |
| **什么都能读** | `add_context("report.pdf")`——PDF、DOCX、XLSX、EPUB、CSV、HTML → Markdown，零预处理。 |

## 工作原理

```
 你 ──► 提示词 ──► RLM 引擎 ──► 聪明模型（逐轮决策，在 repl() 里写 Python）
                          │              │  search / grep / outline  （免费）
                          │              ├─► llm_query ──► 廉价 worker
                          │              └─► rlm_query ──► 子 RLM（深度受限）
                          └──► Σ_t 状态 + 验证 + 预算（token、时钟、错误）
```

- **聪明模型**思考并在 REPL 里写 Python。
- **worker 模型**干重活（阅读、摘要、分类）。
- 困难子问题**递归**给子 RLM。

## 命令

| 命令 | 快捷键 | 说明 |
|---------|----------|-------------|
| `/rlm` | `Ctrl+Shift+R` | 开关 RLM 模式（普通提示词路由进引擎） |
| `/rlm-stop` | | 中止进行中的运行 |
| `/rlm-config` | | 采样、预算、范式开关 |

## 沙箱 API

模型可见面刻意保持极小——只有检索和委派：

```python
search("needle", k=10)            # BM25 指针，指向上下文
grep_context(pattern, k=50)       # 正则命中 + 行号
outline(path)                     # 定义骨架
add_context("report.pdf")         # 附加并自动转换任意文档
llm_query(prompt)                 # 廉价 worker，文本进文本出
map_files(paths, prompt)          # 同一问题问多个文件
rlm_query(task, paths=...)        # 递归子 RLM
answers / plan                    # 跨轮次持久记忆
```

## 安全

- 引擎**不做磁盘 I/O**——一次运行活在内存里；答案是其唯一持久产物。
- API 密钥永不进入沙箱：子 LLM 调用由宿主侧 bridge 处理。
- Python 跑在受控子进程里，有保留名白名单和中断分发。

## 许可证

[MIT](pi-plugin/rlm/LICENSE) © hicaru contributors
