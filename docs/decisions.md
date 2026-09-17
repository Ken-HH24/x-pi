# 设计决策

## D-001：Node.js 24 作为运行基线

状态：已接受。

本机默认 Node.js 为 `v24.18.1`，项目使用 `engines.node >= 24`。这允许教学代码直接使用原生 `fetch`、Web Streams、`AbortController` 和 Node 内置测试能力。

## D-002：DeepSeek 是第一个 provider

状态：已接受。

Chapter 1 直接理解 HTTP 与 SSE，不先引入 OpenAI SDK。模型适配层后续才形成独立 package，以免一开始用抽象掩盖数据流。

## D-003：章节快照与最终应用分离

状态：已接受。

`labs/chapter-*` 保存每章可运行快照，`apps/nano-pi` 持续演进。这样既能回看学习过程，也能保持最终应用连续。

## D-004：核心教学代码每章约 100–150 行

状态：已接受。

限制针对新增核心逻辑。测试、类型和注释不机械计数；如果核心概念无法在限制内讲清，就拆成两章。

## D-005：Harness 延后建设

状态：已接受。

先建立模型流、消息、Session、Agent Loop 和 Extension 边界，再增加 memory 与 sandbox。Harness 可以复用稳定协议，但不反向增加 Nano Pi 的早期复杂度。

