---
order: 8
slug: tool-loop
title: 多轮工具循环
summary: 注册并执行模型请求的工具，把结果放回上下文，并继续模型 turn。
status: completed
lab: chapter-08
diffFrom: chapter-07
delta:
  concepts:
    - Tool result Message 与 provider 的 tool role 转换
    - 工具注册、参数校验和工作区文件读取
  behaviors:
    - 顺序执行工具并把失败作为模型可见结果
    - Agent 自动继续 turn，最多请求模型五次
  files:
    - src/tools.ts：工具注册、参数验证与 read_file
    - src/agent.ts：工具执行事件和多轮循环
    - src/messages.ts：tool result Message 与 LLM 转换
diffFiles:
  - src/messages.ts
  - src/providers/deepseek.ts
  - src/agent.ts
  - src/tools.ts
  - test/session.test.ts
---

# Chapter 8：多轮工具循环

## 一句话总结

Chapter 7 能识别模型发出的结构化工具请求，却不会执行它。本章加入工具注册与参数校验，执行工具后把结果保存为 tool Message 并交回模型，直到模型给出普通回答。

## 为什么需要这一章

工具调用不是最终回答。模型请求 read_file 后，应用需要先验证参数、读取文件、把结果放进对话，再让模型解释读到的内容。缺少这一步，Session 只有一个未完成的 assistant tool call，模型也看不到执行结果。

## 最小运行效果

配置 DEEPSEEK_API_KEY 后运行：

```bash
X_PI_SESSION_FILE=/tmp/x-pi-chapter-08.jsonl \
  pnpm --filter @x-pi/lab-chapter-08 start -- "读取 README.md 并概括项目"
```

终端先显示工具调用与读取结果，随后显示模型基于文件内容生成的最终回答。Session 中依次保存 user、assistant tool call、tool result 和最终 assistant Message。

## 数据流

```text
                         +--------------------+
                         | ToolRegistry       |
                         | schema + execute   |
                         +---------+----------+
                                   ^
                                   | call.arguments
                                   |
User -> Session -> Context -> Model -> assistant toolCall
                         ^                 |
                         |                 v
                 tool result Message <- execute
                         |
                         +---- next turn ----> Model -> final assistant
```

一次 Agent turn 包含一次 assistant 响应和由该响应触发的工具执行。工具结果追加到 Session 后，下一轮重新从记录构建 Context；CLI 只渲染 Agent 事件，不负责循环控制。

## 分步实现

### 1. 用 tool result Message 表达执行结果

应用历史新增如下消息：

```ts
{ role: "tool", toolCallId: "call_1", content: "文件内容", isError: false }
```

toolCallId 将结果关联到前一条 assistant 消息中的调用。isError 留在应用与 Session 层，让 UI 能识别失败；发给 DeepSeek 时，convertToLlm() 和 provider 把它转换为 role: "tool"、tool_call_id 与文本 content。Provider 请求不携带应用专用的 isError 字段。

### 2. 注册工具并在执行前验证参数

ToolRegistry 同时持有厂商可见的 Tool 声明和本地执行函数。重复名称在注册时拒绝；每次调用先确认名称已注册，再按工具的 parameters schema 检查参数。

教学版校验器支持 type（object、string、number、integer、boolean）、object 的 properties、required 和 additionalProperties: false，并递归验证嵌套 object。它不是完整 JSON Schema 实现。校验失败会抛出到 Agent 的工具错误边界，不会调用执行函数。

read_file 使用当前工作目录作为工作区。它拒绝绝对路径，并在读取前解析真实路径，检查符号链接最终指向仍处于工作区内；路径不存在或读取失败也会成为工具错误结果。

### 3. 把异常转换成模型可见结果

Agent 为每个调用发出 tool_execution_start，然后执行注册工具。成功时产生 isError: false 的结果；未知工具、参数错误或执行异常则产生同一 toolCallId 的 isError: true 结果。两种结果都会追加到 Session。

这让工具失败保持在 Agent 事件流中：下一次模型请求仍能看到失败文本并决定如何回应。CLI 通过 tool_execution_end 显示结果摘要，而不需要知道异常来自 schema、路径还是文件系统。

### 4. 按顺序运行下一轮

模型消息完成后，Agent 先提交完整 assistant 消息，再按其内容块顺序执行 tool call。每条 tool result 也作为完整 Message 提交。若至少有一个调用，Agent 结束当前 turn，并开始下一 turn；Context 会从已更新的 Session 重新构建，因此 provider 请求包含调用及其结果。

模型返回不含 tool call 的 assistant 消息时，Agent 发出 turn_end 和 agent_end。每次 run 最多发起五次模型请求。若第五次响应仍要求工具，Agent 仍执行并保存该批结果，发出 turn_end 后以循环上限错误终止，不发起第六次请求；Session 因而不会留下缺少结果的 tool call。

## 端到端例子

假设用户要求“读取 README.md 并概括项目”，模型先请求 read_file：

| 阶段 | 当前数据或状态 |
| --- | --- |
| 用户输入 | user("读取 README.md 并概括项目") 已追加到 Session |
| 模型响应 | assistant(toolCall: call_1, read_file, { path: "README.md" }) |
| 参数检查 | path 存在且为 string；没有未声明字段 |
| 工具执行 | read_file 将相对路径解析到工作区，返回 README 文本 |
| 工具结果 | { role: "tool", toolCallId: "call_1", content: "...", isError: false } |
| 下一次请求 | DeepSeek 收到 assistant tool_calls 与 role: "tool" 结果 |
| 最终回答 | assistant 普通文本进入 Session，run 结束 |

如果读取失败，结果会是相同的 tool Message 形状，但 isError: true、content 是错误说明；模型仍会收到这条结果并继续回答。

## 关键代码与边界

Message 转换保留调用 id，provider 才将它改成厂商字段：

```ts
if (message.role === "tool") {
  return { role: "tool", toolCallId: message.toolCallId, content: message.content };
}
```

Agent 每轮从持久化记录重建输入；模型完成后，工具结果进入同一 Session，因此下一次迭代自然包含调用和结果：

```ts
const context = buildContext(session.records);
const llmMessages = convertToLlm(context.messages);
// 消费完成的 assistant；顺序执行调用并追加每个 tool result。
await session.append(result);
```

`ToolRegistry.execute()` 的关键顺序是先按名称查找、按参数 schema 校验，再执行函数。Agent 捕获执行边界上的异常，转换成相同 `toolCallId` 的错误结果 Message。

buildContext() 保留 tool result，因为它是 role: "tool" 的普通 message record。模型专用格式转换分两步完成：convertToLlm() 消除应用内容结构，DeepSeek provider 再将 toolCallId 映射为厂商字段 tool_call_id。

调用参数先由 Chapter 7 流解析器确保是 JSON object，再由注册表按具体工具 schema 校验。两层校验职责不同：前者保证 JSON 形状完整，后者保证工具实际需要的字段和类型成立。

工具调用按序执行，结果顺序与 assistant 内容块一致。文件工具只处理 UTF-8 文本，工作区限制是本章工具的局部边界；更完整的进程、网络和权限隔离属于后续 Harness 工作。

## 错误与限制

- 未注册工具、schema 不匹配、绝对路径、工作区外真实路径及文件读取错误都会变成模型可见的错误结果。
- 损坏的 tool call JSON 仍在模型流阶段失败，不会进入工具执行器。
- 第五次模型响应如果仍含工具调用，工具批次会完成并保存，但不会再请求模型；run 以循环上限错误结束。
- 当前只有 read_file 示例；schema 校验只是教学子集，不覆盖 JSON Schema 全部关键字。
- 本章没有审批、细粒度权限或操作系统 sandbox。

## 运行和测试

```bash
pnpm --filter @x-pi/lab-chapter-08 test
pnpm --filter @x-pi/lab-chapter-08 typecheck
pnpm docs:build
```

离线测试覆盖消息恢复与 provider 转换、工具参数校验、工作区和符号链接边界、成功执行、失败结果回传及多轮模型请求。

## 与 Pi 源码的关系

本章沿用 Pi packages/agent 的核心事件顺序：assistant message 完成后执行工具，工具结果 Message 进入 Context，turn_end 携带 toolResults，之后可开始下一 turn。Pi 的 AgentEvent 还提供 tool_execution_start / tool_execution_end；Nano Pi 实现相同概念的简化事件，不包含更新流、审批 hook、并行调度或终止策略。[Pi Agent 事件类型](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) · [Pi Agent Loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)

## 代码规模

`tools.ts` 93 行、`agent.ts` 119 行、`messages.ts` 69 行、DeepSeek provider 110 行，合计约 391 行核心文件。本章新增的参数校验与执行边界各自少于 150 行；总量包含前七章延续的消息流和 provider 协议。文件读取、参数校验、结果回传和下一轮请求共同构成一次完整工具往返，适合作为一个章节理解。

## 下一章

Chapter 9 将从当前 CLI 继续处理取消、命令行交互与中断后的恢复行为。

## 完成验收

- [x] 提供总结、运行效果、ASCII 图、分步实现和完整例子。
- [x] 解释关键代码、错误边界与 Pi 源码对应关系。
- [x] 提供离线测试、章节快照和学习网站 Runtime Demo。
- [x] 更新 README、进度、源码地图和章节路线。
