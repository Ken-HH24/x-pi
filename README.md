# x-pi

`x-pi` 是一个长期学习与实践项目：先沿着真实数据流，从零重建一个容易理解的 Nano Pi；再围绕同一套核心协议补充 memory、sandbox、权限和恢复能力，形成真正可用的 Agent harness。

本项目主要参考：

- [earendil-works/pi](https://github.com/earendil-works/pi)：主要源码依据。
- [PI from Scratch](https://pi-from-scratch.vercel.app/)：按数据流理解最小实现。
- [π-agent book](https://books.antinomie.org/pi/)：补充讲解材料。
- [pi.dev](https://pi.dev/)：官方功能与概念文档。
- [Learn Claude Code](https://learn.shareai.run/zh/s01/)：参考渐进式章节组织、能力分层与版本对比体验。

## 两条路线

### 1. Nano Pi：理解核心

从一次 DeepSeek 流式请求开始，逐步加入 Message、事件、Session、Context、Agent Loop、Tool Calling、终端交互、Session Tree、Compaction 和 Extension。每一步都解释它解决的问题，并标出与 Pi 源码的对应关系。

### 2. Agent Harness：补全可用性

在核心链路清晰以后，再增加工具权限、workspace 边界、sandbox、memory、任务恢复、可观测性、审批与评测。Harness 不会提前污染教学实现。

## 学习原则

- 跟着 `用户输入 → 模型流 → Agent 事件 → 工具 → Session` 的数据流学习。
- 每章先用一两句话总结，再给具体例子，然后实现代码。
- 每章新增的核心教学代码优先保持在容易完整理解的范围内，通常可参考 100–150 行，但这不是硬限制。复杂度较高时可以超过 150 行，同时要说明复杂度来源、实际范围，以及为何不适合继续拆章。
- 测试、类型和必要注释不机械计入行数，但不能靠压缩代码规避限制。
- 每章必须有独立的运行或测试方式。
- 新增函数应有适当的中文注释，至少说明函数作用；涉及不直观的数据结构或状态变化时，优先补充输入输出结构、精简示例、边界条件和设计原因，而不是复述语法。
- 每章必须逐段解释关键代码，说明关键状态如何变化以及代码为什么这样设计。
- 每章必须提供一个端到端具体例子，从输入开始展示中间数据，直到最终输出或状态。
- 每章必须提供在 Markdown 源文件中直接可读的 ASCII 图；确实不适用时要明确说明原因。
- `labs/chapter-*` 保存章节快照，`apps/nano-pi` 保存持续演进的版本。
- 原项目持续变化；结论必须区分“已核对源码”和“待后续章节验证”。

## 仓库结构

```text
apps/
  nano-pi/          持续演进的教学 Agent
  agent-harness/    面向实际使用的增强 Agent
  learning-site/    章节学习网站与关键代码 Diff
packages/
  config/           通用环境配置加载
  protocol/         Message、模型事件和 Agent 事件协议
  model-deepseek/   DeepSeek API 适配
  session/          Session 与持久化
  agent-runtime/    Agent loop 与工具执行
  memory/           Harness 记忆能力
  sandbox/          Harness 隔离与权限能力
chapters/           分章节笔记
labs/               每章可运行的代码快照
docs/               进度、源码地图和设计决策
```

## 技术基线

- Node.js 24（本机当前版本：`v24.18.1`）
- TypeScript
- pnpm 11
- DeepSeek 作为第一个模型服务商
- `DEEPSEEK_API_KEY` 只通过环境变量提供

目前没有第三方运行时依赖。只有在手动运行真实模型请求时才需要 `DEEPSEEK_API_KEY`；它可以来自 shell 环境变量或仓库根目录的 `.env`。离线测试不会消耗 API 额度。

## 当前进度

当前完成 Chapter 5：从完整 Session record 选择本轮 Context，再转换成模型 Message；持久化记录不再默认全部进入模型。下一步是 Chapter 6：建立最小 Agent Loop。

新会话开始时，先阅读 [docs/progress.md](docs/progress.md)，再阅读当前章节文档。

编写新章节时使用 [章节模板](docs/chapter-template.md) 作为验收清单。

## 章节路线

| 章节 | 主题 | 状态 |
| --- | --- | --- |
| 00 | 阅读地图与最小工程 | 已完成 |
| 01 | DeepSeek 流式请求 | 已完成 |
| 02 | Message 与内容块 | 已完成 |
| 03 | 统一模型事件流与 Provider 演进 | 已完成 |
| 04 | Session 与 JSONL | 已完成 |
| 05 | Context 构建与模型转换 | 已完成 |
| 06 | 最小 Agent Loop | 待开始 |
| 07 | Tool Calling 协议 | 未开始 |
| 08 | 多轮工具循环 | 未开始 |
| 09 | CLI、取消与恢复 | 未开始 |
| 10 | Session Tree 与分支 | 未开始 |
| 11 | Compaction | 未开始 |
| 12 | Extension 与生命周期事件 | 未开始 |
| 13 | 对照 Pi 源码复盘 | 未开始 |

## 常用命令

```bash
pnpm check
pnpm test
pnpm typecheck
pnpm --filter @x-pi/nano-pi start -- "你好"
pnpm docs:dev
pnpm docs:build
```

`pnpm docs:dev` 会启动定制学习网站。网站直接读取 `chapters/*/README.md`，并从相邻 `labs/chapter-*` 快照生成每章选定文件的真实代码 Diff。推送到 `main` 后可由 GitHub Actions 发布到 GitHub Pages。

应用通过共享 `@x-pi/config` 从当前目录向上查找最近的 `.env`，因此最后一条命令可以从 monorepo 任意层级启动。也可以用 `ENV_FILE` 指定配置文件。完整讲解见 [Chapter 1](chapters/01-deepseek-stream/README.md)。
