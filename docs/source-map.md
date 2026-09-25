# Pi 源码学习地图

更新时间：2026-09-20。

本文件不是永久正确的架构说明，而是 `x-pi` 学习过程中持续校准的索引。Pi 主仓库变化很快；进入每个章节时仍需重新核对相关源码。

## 已核对的整体结构

Pi 当前主仓库的核心 package 包括：

| Pi package | 当前职责 | x-pi 对应位置 |
| --- | --- | --- |
| `packages/ai` | 多 provider 模型抽象、消息与流式响应 | `packages/model-deepseek`、`packages/protocol` |
| `packages/agent` | Agent 状态、事件流、工具执行和循环 | `packages/agent-runtime` |
| `packages/coding-agent` | CLI、Session、上下文、扩展和内置工具 | `apps/nano-pi`，后续部分进入 Harness |
| `packages/tui` | 终端 UI 与差量渲染 | 前期使用极简 CLI，后期单独学习 |
| `packages/protocol` | 跨进程协议类型 | Nano Pi 后期按需要覆盖 |
| `packages/client` / `server` | 远程或进程外集成边界 | 暂不进入基础路线 |
| `packages/session-backends/*` | 可替换的 Session 存储后端 | `packages/session` 后期扩展 |

## 已确认的关键设计

### Chapter 1：OpenAI-compatible 文本流

DeepSeek 当前官方 Chat API 使用 `POST https://api.deepseek.com/chat/completions`，设置 `stream: true` 后以 SSE 返回 OpenAI-compatible chunk。Pi 将这类接口归入模型 API 层；Nano Pi 本章通过注入的 `deepSeekProvider` 解析 `choices[0].delta.content`，通用 SSE 层不依赖厂商格式，并要求 provider 产生 done 事件才视为完整结束。

本章只实现最小 `TextProvider`，并未照搬 Pi 的完整模型系统。reasoning、tool calls、usage、provider registry、重试和统一 AssistantMessage 事件会等到各自问题出现时再加入。

### Chapter 2：应用 Message 与模型请求

Nano Pi 现在用带 `role` 的 user/assistant Message 和 `TextContent[]` 保存应用侧对话。调用 DeepSeek 时，provider 才通过 `textOf()` 把内容块顺序连接成 OpenAI-compatible 的字符串 `content`；HTTP/SSE 层只接收 `Message[]`，不依赖块的内部结构。

流式文本仍来自 Chapter 1 的 Async Generator，但 `collectAssistantMessage()` 会把每个增量同时送给终端并追加到一个 assistant text block，在 done 之后返回完整 Message。这对应 Pi 中“流式构建响应”和“应用消息不等于厂商请求格式”的核心边界，但还是教学简化：没有 usage、stop reason、timestamp、reasoning 或 tool call。

### Chapter 3：Provider、Model、API 与统一事件

Pi 当前的 `Model` 保留 `api` 身份；`Provider` 持有模型列表和 stream 行为，并在内部按 `model.api` 选择 API 实现。DeepSeek provider 组合 `openAICompletionsApi()`，不单独实现协议。Nano Pi 将原来的 `TextProvider` 拆成最小 `ModelProvider`、`Model` 和 `ChatCompletionsApi`，但暂不实现 registry、认证存储或动态模型发现。

Pi 的 `AssistantMessageEvent` 是一个可辨识联合：成功流以 `start` 开始，中间有 text/thinking/tool-call 的 start、delta 和 end，最后以 `done` 结束；失败以 `error` 结束。`partial` 是共享的实时响应，而不是事件时刻的快照。Nano Pi 实现纯文本子集 `start -> text_delta* -> done`，同样用共享 partial 构建最终 Message；错误仍保持抛异常，留待 Agent Loop 阶段统一。

### Chapter 4：Session JSONL 与恢复

Pi 当前 Session 文件的第一行是 version 3 header，后续 entry 以 JSONL 追加；message entry 包含完整 AgentMessage，并通过 `id` / `parentId` 组成树。`SessionManager.appendMessage()` 推进当前 leaf，`buildSessionContext()` 再沿当前分支恢复模型上下文。Pi 的终态 assistant Message 才会进入 Session，`pending` 不应出现在持久化文件中。

Nano Pi 本章只保留追加日志的核心：每行是 `{ type: "message", timestamp, message }`，启动时按顺序恢复为 `Message[]`。它尚无 header、版本迁移、entry id、parentId 或 leaf；这些树形职责明确留给 Chapter 10。为处理进程在追加中途退出的情况，没有换行的最后一段被视为未提交记录并忽略；其他格式错误会携带行号失败，不静默跳过历史中的损坏。

### Chapter 5：Context 构建与模型转换

Pi 当前 `buildSessionContext()` 先沿活动分支选择 context entries，处理 compaction 与 branch summary，再转换成 `AgentMessage[]`；模型和 thinking 设置也从同一路径恢复。Agent loop 会先运行可选的 `transformContext()`，再调用 `convertToLlm()`，后者负责把 coding-agent 自定义消息变成 `pi-ai` Message，并过滤不应进入模型的消息。custom Session entry 不参与 LLM context，而 custom message entry 会参与。

Nano Pi 保留这一职责顺序但继续使用线性历史：`Session.records` 保存 message 与 note，`buildContext()` 只选择 message record，`convertToLlm()` 再把应用 content block 合并为纯文本 `LlmMessage`。note 展示“值得持久化但不该发送给模型”的边界；树形路径、摘要和工具消息仍留给后续章节。

### Chapter 6：Agent Loop 与生命周期事件

Pi 当前 `AgentEvent` 分为 Agent、turn、message 和工具执行四组生命周期。新 prompt 的基础顺序是 `agent_start → turn_start → prompt message_start/end → assistant message_start/update/end → turn_end → agent_end`；一次 turn 包含一条 assistant 响应以及由它触发的工具调用与结果。模型流的 partial 会进入当前 Context，并在更新时被替换为最新响应。

Nano Pi 实现无工具的单-turn 子集：`runAgent()` 提交 user、构建 Context、调用模型并只提交 done assistant，再发出稳定的 Agent 事件。`turn_end.toolResults` 当前恒为 `[]`，为后续工具循环保留形状；CLI 只读取 `message_update.modelEvent.delta`。与模型层共享 partial 不同，Agent 事件保存当时的消息快照，避免旧事件被后续 delta 改写。错误合成、工具、多 turn、steering 与 follow-up 仍留给后续章节。

### Chapter 7：Tool Calling 协议

Pi 当前 `packages/ai` 的 assistant 内容可包含 tool call，流式事件使用 `toolcall_start`、`toolcall_delta` 和 `toolcall_end`，并通过 `contentIndex` 把事件关联到内容数组中的块。不同块的事件允许交错；最终 tool call 包含 `id`、`name` 和结构化 `arguments`，但 end 本身不代表已经按工具 schema 验证。`packages/agent` 再把这些模型事件包装进 `message_update`，工具执行使用另一组生命周期事件。

Nano Pi 实现 DeepSeek Chat Completions 的 function tool 子集：应用侧 `Tool` 声明在 provider 边界转换，`delta.tool_calls[index]` 被展开成原子 ProviderEvent，模型流以 Map 按 index 累积原始参数字符串，并在 done 时严格解析为 JSON object。模型与 Agent 事件均暴露 start/delta/end；完整 assistant tool call 可以持久化和恢复，但实际执行、schema 校验、tool result 和下一 turn 明确留到 Chapter 8。

### Chapter 8：多轮工具循环

Pi 当前 `packages/agent/src/types.ts` 定义 `tool_execution_start` / `tool_execution_end`，并将一个 turn 描述为 assistant 消息、工具调用与结果；`agent-loop.ts` 在工具调用后把 ToolResultMessage 加入 Context，再决定是否进入下一轮。Nano Pi 用 `ToolRegistry` 配对厂商声明和执行函数，内置常用 schema 子集校验，按序执行工具，保存 `{ role: "tool", toolCallId, content, isError }`，provider 转为 DeepSeek 的 `tool_call_id`。本教学版限 `read_file` 示例与五次模型请求，不含 Pi 的并行模式、审批 hook、更新事件或完整 JSON Schema。

### 模型消息与 Agent 消息分离

Pi Agent 允许应用自定义 `AgentMessage`，但调用模型前必须经过 `transformContext()` 和 `convertToLlm()`，最终只发送模型理解的消息。Nano Pi 会先从少量消息类型开始，但保留“存储/应用消息不等于 provider 请求格式”这一边界。

### Provider 事件与 Agent 事件分离

模型层负责将厂商流转换成稳定的消息增量；Agent 层再发出 `agent_start`、`turn_start`、`message_update`、工具执行和结束事件。我们会分两章实现这两层，避免 UI 直接理解 DeepSeek 的 SSE 格式。

### Agent Loop 以 turn 为单位

一次 turn 包含一次模型响应和由该响应触发的工具执行。存在工具结果时，Agent 会开始下一次 turn，直到模型不再请求工具或运行被终止。

### Session 是树，不只是聊天数组

Pi 文档明确说明 Session 使用 JSONL，并以树结构保存分支。Nano Pi 会先学习追加日志，再引入 parent 指针、分支导航和 compaction，避免第一章就承担完整复杂度。

### Harness 需要自己定义安全边界

Pi 官方说明默认继承启动进程的文件、进程、网络和凭据权限；严格隔离需要容器或 sandbox。这正是本仓库 Harness 路线需要补充的主要能力之一。

## 章节映射

| x-pi 章节 | 重点核对的 Pi 区域 |
| --- | --- |
| 01–03 | `packages/ai` 的 provider/model/API 分层、stream 与消息事件 |
| 04–05 | `packages/coding-agent` 的 session/context，以及 session format 文档 |
| 06–08 | `packages/agent` 的 Agent、agent loop、工具执行与事件顺序 |
| 09 | `packages/coding-agent` CLI 与 `packages/tui` |
| 10 | SessionManager、JSONL entry 与 tree navigation |
| 11 | compaction 与 branch summarization |
| 12 | extensions、events、skills 与动态 context |
| 13 | 全链路差异复盘 |

## 尚待源码级验证

- DeepSeek 在当前 Pi provider registry 中的完整模型元数据；本章仅确认它复用 OpenAI-compatible API 路径。
- `packages/ai/src` 中 tool-call 参数拼接的全部 provider 差异。
- `packages/coding-agent/src` 中 compaction 和扩展加载的最新文件边界；SessionManager 的 header、message entry、树结构、context 构建与 `convertToLlm` 边界已在 Chapter 4–5 核对。
- 新增 `protocol`、`client/server` 后与本地 coding-agent 的具体协作关系。

这些内容会在对应章节开始前核对并写入本文件，不在 Chapter 0 中提前下结论。

## 参考链接

- <https://github.com/earendil-works/pi>
- <https://github.com/earendil-works/pi/tree/main/packages/ai>
- <https://github.com/earendil-works/pi/tree/main/packages/agent>
- <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- <https://pi.dev/docs/latest>
- <https://pi-from-scratch.vercel.app/>
- <https://learn.shareai.run/zh/s01/>
- <https://api-docs.deepseek.com/guides/reasoning_model>
