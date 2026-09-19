---
order: 6
slug: agent-loop
title: 最小 Agent Loop
summary: 让 Agent 层拥有一次 turn，并把模型流提升为 CLI 可消费的稳定生命周期事件。
status: completed
lab: chapter-06
diffFrom: chapter-05
delta:
  concepts:
    - Agent run、turn 与 message 三层生命周期
    - 模型事件和 Agent 事件是两条不同边界
  behaviors:
    - Agent 负责提交 user、构建 Context、调用模型并提交完整 assistant
    - CLI 只消费 message_update，不再直接编排模型流
  files:
    - src/agent.ts：最小 Agent Loop 与 AgentEvent
    - src/main.ts：只订阅 Agent 事件的终端入口
diffFiles:
  - src/agent.ts
  - src/main.ts
  - test/session.test.ts
---

# Chapter 6：最小 Agent Loop

## 一两句话总结

前五章已经能完成一轮对话，但调用模型、提交消息和更新终端仍挤在 `runTurn()` 中。本章引入最小 Agent Loop：它拥有一次 turn 的完整生命周期，并把底层模型事件提升成稳定的 Agent 事件，CLI 只负责显示。

## 为什么需要这一章

Chapter 5 的 `runTurn()` 同时知道 Session、Context、模型流和 `onText` 回调。它能工作，却没有一个可供 CLI、测试、日志或未来工具共同观察的运行边界。

直接让 CLI 消费 `start / text_delta / done` 也不够：这些事件只描述一条 assistant 消息，不知道整个 Agent 何时开始、一轮何时结束、user 何时提交，未来更无法在两次模型请求之间插入工具结果。

本章把三个生命周期分开：

| 层级 | 开始与结束 | 当前含义 |
| --- | --- | --- |
| Agent run | `agent_start` / `agent_end` | 处理一次用户请求；当前只有一个 turn |
| Turn | `turn_start` / `turn_end` | 一次 assistant 响应及其工具结果；当前工具结果为空 |
| Message | `message_start` / `message_update` / `message_end` | user 或 assistant 消息的产生过程 |

## 最小运行效果

用户仍然只看到流式文本：

```text
$ pnpm --filter @x-pi/nano-pi start -- "解释 Agent Loop"
Agent Loop 负责推进模型、消息和工具的生命周期。
```

但测试或其他消费者能观察到完整事件轨迹：

```text
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant: "")
message_update(assistant: "Agent ", delta: "Agent ")
message_update(assistant: "Agent Loop", delta: "Loop")
message_end(assistant: "Agent Loop")
turn_end(toolResults: [])
agent_end
```

## Agent Loop 总流程图

下面的图同时表达控制流与事件流。竖线是主执行路径，右侧是消费者能看到的事件；`message_update*` 表示零次或多次更新。

```text
runAgent(session, prompt, provider, options)
  |
  +-- yield agent_start ------------------------------------> CLI / logger / test
  +-- yield turn_start ------------------------------------->
  |
  +-- userMessage(prompt)
  +-- yield message_start(user) ---------------------------->
  +-- Session.append(user)          [user 已提交]
  +-- yield message_end(user) ------------------------------>
  |
  +-- buildContext(Session.records)
  +-- convertToLlm(Context.messages)
  +-- streamModel(LlmMessage[])
  |     |
  |     +-- start
  |     |     `-- yield message_start(assistant empty) ------>
  |     |
  |     +-- text_delta*                                     LOOP
  |     |     +-- snapshot(partial)
  |     |     `-- yield message_update(message, delta) ------> CLI 写 delta
  |     |
  |     `-- done
  |           +-- Session.append(assistant) [完整消息已提交]
  |           +-- yield message_end(assistant) ------------->
  |           `-- yield turn_end(toolResults: []) ---------->
  |
  `-- yield agent_end(messages: [user, assistant]) --------->
```

当前只有一轮，真正的“循环入口”是模型事件的 `for await`。Chapter 8 加入工具后，`turn_end` 之后会根据 tool result 决定是否回到新的 `turn_start`：

```text
                         +-------------------------------+
                         |                               |
                         v                               |
agent_start --> turn_start --> assistant response --> turn_end
                         |                         |
                         | tool call + result      | no tool call
                         +-------------------------+-----> agent_end
                              Chapter 8 才启用
```

## 分步实现

### 1. 定义 Agent 层事件

`src/agent.ts` 用可辨识联合定义最小事件集：

```ts
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: AssistantMessage; modelEvent: TextDeltaEvent }
  | { type: "message_end"; message: Message }
  | { type: "turn_end"; message: AssistantMessage; toolResults: readonly Message[] }
  | { type: "agent_end"; messages: readonly Message[] };
```

`message_update` 同时携带两种信息：`modelEvent.delta` 适合终端增量渲染，`message` 是更新后的 assistant 快照，适合状态面板或测试检查累计结果。CLI 不需要知道 DeepSeek chunk、SSE 或共享 partial。

`turn_end` 现在已经包含 `toolResults`，但值恒为 `[]`。这是一个由下一章需求已经明确的边界，不是提前实现工具协议：消费者现在就能依赖稳定的 turn 形状。

### 2. Agent 提交 user 并发出消息事件

`runAgent()` 是 Async Generator。调用方每次迭代得到一个事件，而函数内部仍能顺序等待 Session 和模型：

```ts
yield { type: "agent_start" };
yield { type: "turn_start" };

const user = userMessage(prompt);
yield { type: "message_start", message: user };
await session.append(user);
emittedMessages.push(user);
yield { type: "message_end", message: user };
```

`message_end(user)` 在 `Session.append()` 成功后才发出。因此本教学实现里，“user 消息结束”也表示它已经成为可恢复事实；如果磁盘写入失败，事件流抛错，不会谎报结束。

### 3. Agent 在内部建立本轮模型输入

user 提交后，Agent 沿用 Chapter 5 的职责顺序：

```ts
const context = buildContext(session.records);
const llmMessages = convertToLlm(context.messages);
for await (const modelEvent of streamModel(llmMessages, provider, options)) {
  // 把 ModelEvent 提升成 AgentEvent
}
```

这三步都不再出现在 CLI。之后即使 Context 增加裁剪策略，或 Agent 在第二个 turn 追加 tool result，终端入口也不需要改变。

### 4. 把模型消息生命周期提升为 Agent 事件

模型 `start` 对应 assistant `message_start`，每个 `text_delta` 对应一次 `message_update`，模型 `done` 对应最终提交与 `message_end`：

```ts
if (modelEvent.type === "start") {
  yield { type: "message_start", message: snapshot(modelEvent.partial) };
} else if (modelEvent.type === "text_delta") {
  yield {
    type: "message_update",
    message: snapshot(modelEvent.partial),
    modelEvent,
  };
} else {
  await session.append(modelEvent.message);
  yield { type: "message_end", message: modelEvent.message };
}
```

模型层的 `partial` 是共享可变对象；后一个 delta 会继续修改它。如果 Agent 直接把同一个引用交给所有消费者，测试结束后回看第一个事件也会看到最终文本。本章的 `snapshot()` 深复制当前文本块，使已发出的 Agent 事件代表当时状态，不被未来更新改写。

### 5. 关闭 turn 与 Agent run

assistant 完整落盘后，生命周期按从内到外的顺序关闭：

```ts
yield { type: "message_end", message: modelEvent.message };
yield { type: "turn_end", message: modelEvent.message, toolResults: [] };
yield { type: "agent_end", messages: emittedMessages };
return modelEvent.message;
```

`agent_end.messages` 只包含这次 run 新产生的 user 和 assistant，不重复携带恢复出来的旧历史。Session 仍保存完整历史；两者回答的是不同问题。

### 6. CLI 降为纯事件消费者

`src/main.ts` 不再导入 `streamModel()`、构建 Context 或提交消息：

```ts
for await (const event of runAgent(session, prompt, deepSeekProvider, options)) {
  if (event.type === "message_update") {
    process.stdout.write(event.modelEvent.delta);
  }
}
```

终端只关心增量文字，其他消费者可以用同一事件流做日志、状态展示或协议输出。这正是 Agent 事件层的价值：一次执行只有一个所有观察者共享的事实顺序。

## 关键代码解释

`runAgent()` 并不是“无限自主循环”。它现在只有一个 turn，但已经建立循环所需的稳定边界：run 包含 turn，turn 包含 message；模型完成后由 Agent 判断下一步。工具尚未出现，所以判断结果总是结束。

Async Generator 同时解决控制与观察两个问题：Agent 可以在 `await session.append()`、`for await streamModel()` 之间保持顺序，调用方又能在运行过程中逐事件消费，而不必等整个函数返回。

模型事件没有被 Agent 事件取代。前者描述“assistant 如何从 provider 增长”，后者描述“整个 Agent 正处于哪个生命周期”。`message_update.modelEvent` 保留底层 delta，让渲染无需比较两个完整快照。

## 端到端完整例子

假设已有历史 `user("旧问题") → assistant("旧回答")`，现在输入“解释 Agent Loop”，模型分两段返回 `Agent ` 和 `Loop`：

| 阶段 | 当前数据或状态 |
| --- | --- |
| `agent_start` | 新 run 开始，尚未产生新消息 |
| user `message_start` | 内存中已构造 `user("解释 Agent Loop")` |
| user `message_end` | Session 已提交新 user，共 3 条历史消息 |
| Context | 旧问题、旧回答和新问题被转换成 3 条 `LlmMessage` |
| assistant `message_start` | 快照文本为空字符串 |
| 第一次 `message_update` | `delta = "Agent "`，快照文本为 `"Agent "` |
| 第二次 `message_update` | `delta = "Loop"`，快照文本为 `"Agent Loop"` |
| assistant `message_end` | 完整 assistant 已提交，Session 共 4 条消息 |
| `turn_end` | `message = assistant("Agent Loop")`，`toolResults = []` |
| `agent_end` | 本次新增消息是 `[user, assistant]`，旧历史不重复返回 |

## 错误与边界条件

- user 写入失败时，不发出 user `message_end`，模型也不会启动。
- HTTP、SSE、解析或取消错误继续向调用方抛出；当前不会合成失败 assistant 或补发 `turn_end / agent_end`。
- 模型流只有收到 `done` 才提交 assistant；截断流只保留已经提交的 user。
- `message_update.message` 是事件时刻快照，`modelEvent.partial` 仍保持模型层共享 partial 的既有语义。
- 当前没有工具，因此只有一个 turn，`toolResults` 恒为空。
- 同一个 `Session` 尚未防止多个 `runAgent()` 并发写入；CLI 当前一次只启动一个 run。

## 运行和测试

```bash
node --test apps/nano-pi/test/*.test.ts
node --test labs/chapter-06/test/*.test.ts
./node_modules/.bin/tsc -p apps/nano-pi/tsconfig.json --noEmit
./node_modules/.bin/tsc -p labs/chapter-06/tsconfig.json --noEmit
pnpm docs:build
```

新增测试验证：

- 完整事件顺序严格匹配 Agent、turn 和 message 生命周期。
- 恢复的历史仍会进入请求，Session note 仍被 Context 排除。
- 两个 `message_update` 分别保留 `"Agent "` 与 `"Agent Loop"` 快照。
- `turn_end.toolResults` 当前明确为空。
- 截断模型流仍只持久化 user，不持久化 partial assistant。

## 与 Pi 源码的关系

本章于 2026-09-19 核对了 Pi 当前 `packages/agent`：

- `AgentEvent` 包含 `agent_start/end`、`turn_start/end`、`message_start/update/end` 与工具执行事件。
- 新 prompt 的顺序是 `agent_start → turn_start → prompt message_start/end → assistant message lifecycle`。
- 一次 turn 定义为一条 assistant 响应及其触发的工具调用与 tool result。
- 流式 assistant 在模型 `start` 时进入当前 Context，更新时替换 partial，完成后发出 `message_end`。
- Pi 的完整 loop 还处理工具、多 turn、steering、follow-up、错误消息和停止策略。

Nano Pi 只保留无工具的单-turn 子集，并让 Agent 直接拥有 Session 提交；Pi 的 Session 持久化位于更外层 coding-agent 集成中。这里选择直接提交，是为了让本章清楚建立“CLI 不编排模型和存储”的教学边界，后续 Extension 章节再讨论事件订阅与持久化解耦。源码依据为 [agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)、[types.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) 与 [agent.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)。

## 代码规模

- `agent.ts` 约 80 行：事件联合、快照和单-turn Agent Loop。
- `main.ts` 仅替换约 10 行：从直接运行 turn 改为消费 Agent 事件。
- 测试新增约 60 行：事件轨迹、快照与失败提交规则。

核心实现小于常见的 100–150 行参考范围，因为模型流、Context 与 Session 已由前五章完成；本章只负责把这些能力纳入一个可观察的生命周期。

## 已知限制

- 没有 tool call、tool result 或第二个 turn。
- 失败和取消通过抛异常表达，尚无 Agent 级 error 终态事件。
- 没有事件订阅器集合、Agent 状态对象、steering 或 follow-up 队列。
- Agent 与 Session 仍直接耦合，尚未抽成独立 runtime package。
- CLI 只显示文本 delta，没有根据其他事件显示状态。

## 下一章

Chapter 7 会扩展 Message、模型事件和 Agent 事件，使 assistant 能产生结构化 tool call；届时本章预留的 `turn_end.toolResults` 仍为空，因为工具执行与多轮循环会在 Chapter 8 接上。

## 完成验收

- [x] 有一两句话总结和最小运行效果。
- [x] 有与真实实现一致、在 Markdown 源文件中直接可读的 ASCII 图。
- [x] 有关键代码解释，包含设计原因和状态变化。
- [x] 有从输入到结果的端到端完整例子。
- [x] 有错误与边界条件说明。
- [x] 有可执行的测试或验证方法。
- [x] 有与 Pi 源码的对应关系。
- [x] 有代码规模、已知限制和下一章入口。
- [x] 已更新 `README.md`、`docs/progress.md` 和 `docs/source-map.md`。
- [x] 已保存对应的 `labs/chapter-06` 快照。
- [x] 已更新学习网站“源码与运行”的交互演示，并验证其中的源码、状态和命令与本章快照一致。
- [x] `pnpm docs:build` 成功，且本章“源码与运行”页签具有完整结构。
