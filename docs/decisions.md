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

## D-004：核心教学代码保持在可理解的有限范围

状态：已接受。

100–150 行是帮助控制教学复杂度的参考范围，不是硬性上限。限制关注新增核心逻辑；测试、类型和必要注释不机械计数。复杂度较高时允许超过 150 行，但章节必须列出实际规模，说明复杂度来源、为何这些代码属于同一个不可轻易拆分的概念，以及为何继续拆章反而会破坏完整数据流。无论是否超出参考范围，代码规模都应有明确边界，不能无约束增长。

## D-005：Harness 延后建设

状态：已接受。

先建立模型流、消息、Session、Agent Loop 和 Extension 边界，再增加 memory 与 sandbox。Harness 可以复用稳定协议，但不反向增加 Nano Pi 的早期复杂度。

## D-006：第一章不使用模型 SDK

状态：已接受。

使用 Node.js 24 原生 `fetch`、Web Streams 和 `AbortController`，直接观察 HTTP、SSE 与网络分片。SDK 或 provider 抽象要在理解底层数据流后再引入。

## D-007：关键代码必须有适当注释

状态：已接受。

新增函数应有适当的中文注释，至少说明它解决什么问题。涉及不直观的数据结构、输入输出或状态推进时，应尽量在函数附近补充精简结构或示例，并解释边界、约束和设计原因，例如网络分片、协议完整性、取消传播与测试接缝。注释不逐行复述语法；复杂流程仍由章节正文完整串起。

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

## D-013：学习网站按能力层组织渐进版本

状态：已接受。

网站参考 Learn Claude Code 的课程体验：使用紧凑顶栏、分层侧边导航、`c01` 式章节编号和“学习 / 本章增量 / 关键 Diff / 源码与运行”标签。全局提供学习路径、版本对比与架构层视图；视觉保持中性、克制和代码优先，不照搬其品牌或内容。

## D-014：模型流使用显式生命周期事件

状态：已接受。

Chapter 3 起，模型层不再向上层产生裸字符串，而是产生 `start`、`text_delta` 和 `done` 事件。正常完成只能由 done 表达，中断流不得被误当成完整响应。事件中的 partial 是一个共享的、持续增长的 AssistantMessage，与 Pi 当前的流语义保持一致。

## D-015：Session 先实现线性追加日志

状态：已接受。

Chapter 4 的 Session 每行只保存 `type`、`timestamp` 和完整 `message`。user Message 在请求前追加，assistant Message 只在模型产生 `done` 后追加；没有换行的尾部数据视为崩溃时的未提交记录并忽略，其他损坏记录明确报错。Pi 的 header、entry id、parentId、树形分支和迁移属于已核对但刻意延后的能力，将在 Chapter 10 引入。

## D-016：Context 选择与模型转换分离

状态：已接受。

Chapter 5 起，Session 保留完整 record，`buildContext()` 负责选择参与本轮推理的应用 Message，`convertToLlm()` 再把应用内容转换为模型层 Message，provider 只负责厂商请求外壳与响应协议。`note` record 作为最小反例持久化但不进入 Context；这条边界将承接后续工具消息、扩展状态、分支与 compaction。

## D-017：每个实现章节必须提供完整的“源码与运行”演示

状态：已接受。

除 Chapter 0 外，每个完成的章节不仅要有 lab、Diff、运行命令和正文，还必须在学习网站提供与 Chapter 01–04 同等完整的交互式 Runtime Demo。演示逐步展示终端输出、关键状态、对应源码与真实数据流；新增章节若存在 lab 却没有演示，`pnpm docs:build` 必须失败，避免静默退化为空白的“源码与运行”页面。特殊运行方式需要同步更新章节页的 `runCommand`。

## D-018：CLI 只消费 Agent 生命周期事件

状态：已接受。

Chapter 6 起，Agent 层拥有 user 提交、Context 构建、一次模型调用和完整 assistant 提交，并发出 Agent、turn 与 message 生命周期事件。CLI 不直接消费模型流，也不负责 Session 提交；它只从 `message_update` 读取文本 delta。模型 partial 可以保持共享可变语义，但 Agent 事件携带事件时刻的消息快照，避免历史事件被后续增量改写。
