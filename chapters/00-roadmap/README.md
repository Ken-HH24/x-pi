# Chapter 0：先画地图，再开始写 Agent

## 一句话总结

Pi 可以先理解为三层稳定边界：模型层把厂商响应变成流式消息，Agent 层运行模型与工具循环，应用层负责 Session、上下文和界面。我们将沿着一条真实请求的数据流逐层重建它。

## 先看一个例子

用户输入“读取 package.json”后，一次完整执行可能是：

```text
用户输入
  → CLI 追加 user message
  → Agent 请求模型
  → DeepSeek 流式返回 tool call
  → Agent 执行 read_file
  → 追加 tool result
  → Agent 再次请求模型
  → 流式显示最终答案
  → Session 追加本轮记录
```

这条链路包含了后续所有核心问题：消息怎么表示、流怎么拼接、工具怎么调用、历史怎么恢复、UI 为什么不应依赖厂商格式。

## 为什么不从“设计完整架构”开始

如果先写一组空接口，很难判断抽象是否真的有用。Chapter 1 会直接请求 DeepSeek；遇到第一处变化边界时再提取 Message 和事件，遇到需要连续对话时再引入 Session。每个模块都由一个已经出现的问题推动。

## Pi 当前给出的地图

根据当前仓库和官方文档：

- `pi-ai` 统一模型厂商、模型消息和流式响应。
- `pi-agent-core` 管理 Agent 状态、turn、工具执行和事件。
- `pi-coding-agent` 组合 CLI、Session、上下文、扩展和工具。
- `pi-tui` 负责终端呈现，不应理解 provider 协议。
- Session 采用 JSONL，并支持树形历史和分支。
- Pi 默认不提供强文件/进程隔离，sandbox 属于外部部署或扩展能力。

源码级对应关系维护在 `docs/source-map.md`，每章开始前继续细化。

## 两条实现轨道

### Nano Pi

目标是理解。每章只增加一个核心概念，代码保持小而直接。

### Agent Harness

目标是可用。它在 Nano Pi 的稳定边界上增加权限、隔离、记忆、恢复、审计和评测，不要求教学代码一开始就承担这些责任。

## 本章产物

- pnpm monorepo 根配置。
- 两个应用与六个预留 package 的工作区骨架。
- 根 README 和完整章节路线。
- 跨 session 的进度恢复文件。
- Pi 第一版源码学习地图和设计决策记录。

本章没有业务代码，也不安装依赖。

## 验证

```bash
node --version
pnpm --version
pnpm list -r --depth -1
```

预期 Node.js 主版本为 24，并且 pnpm 能识别根 workspace 及两个应用、六个 package。

## 已知限制

- 源码地图目前只确认 package 职责和公开事件模型，尚未逐文件追踪内部实现。
- 空 package 只是路线占位，不代表已经确定最终 API。
- Chapter 1 前不会创建通用 provider 接口。

## 下一章

Chapter 1 将只解决一个问题：DeepSeek 如何通过 SSE 把一个回答分成许多增量传回来，以及 Node.js 如何正确消费、取消和报告这条流。

