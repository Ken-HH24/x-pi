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

## D-006：第一章不使用模型 SDK

状态：已接受。

使用 Node.js 24 原生 `fetch`、Web Streams 和 `AbortController`，直接观察 HTTP、SSE 与网络分片。SDK 或 provider 抽象要在理解底层数据流后再引入。

## D-007：关键代码必须有适当注释

状态：已接受。

教学代码应注释容易误解的边界、约束和设计原因，例如网络分片、协议完整性、取消传播与测试接缝。注释主要解释“为什么”，不逐行复述语法；每章讲解仍负责完整串起代码的数据流。

## D-008：模型厂商通过 Provider 注入

状态：已接受。

通用 HTTP/SSE 流程不能导入具体厂商。Chapter 1 使用最小 `TextProvider` 注入 URL、认证、请求体和事件解析；Chapter 3 再结合统一模型事件，将其演进为更接近 Pi 的 provider、model 与 API 实现分层。

## D-009：每章必须包含三种教学材料

状态：已接受。

从 Chapter 1 开始，每章必须包含：关键代码解释、从输入到结果的端到端具体例子，以及展示主要模块、数据流或状态变化的 ASCII 图。三者都属于章节完成条件。图必须放在普通文本代码块中，保证直接阅读 Markdown 源文件时也清晰可见；如果某章确实不适合图示，必须写明原因。

## D-010：环境文件由共享配置包加载

状态：已接受。

所有应用通过 `@x-pi/config/register` 加载配置，不硬编码 `../../.env`，也不在根脚本中为每个应用建立专用命令。配置包从当前目录向上查找最近的 `.env`，并支持用 `ENV_FILE` 显式指定文件；同一机制可供任意后续应用复用。

## D-011：应用 Message 使用带类型的内容块

状态：已接受。

Nano Pi 从 Chapter 2 起使用带角色的 Message 和 `content` 数组，不把裸字符串或厂商请求对象作为应用历史。当前只有 text block；在 provider 边界才转换成 DeepSeek 接受的字符串 content。这样后续新增 reasoning、tool call 或其他 provider 时不需要改写已有历史的基本边界。

## D-012：章节网站以 Markdown 和 lab 快照为单一来源

状态：已接受。

定制 Astro 网站不复制教学正文：构建前从 `chapters/*/README.md` 生成内容集合，并依据章节 frontmatter 中的 `diffFiles` 对比相邻 `labs/chapter-*`。每章同时提供人工整理的概念、行为和文件增量，以及少量关键文件的真实 Diff；不展示整仓噪声差异。
