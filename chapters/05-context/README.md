---
order: 5
slug: context
title: 从 Session 构建模型 Context
summary: 让 Session 保存完整事实，由 Context 选择可见消息，再统一转换为模型输入。
status: completed
lab: chapter-05
diffFrom: chapter-04
delta:
  concepts:
    - Session record、应用 Message 与模型 Message 是三种不同数据
    - buildContext 负责选择，convertToLlm 负责转换
  behaviors:
    - 持久化 note record，但不把它发送给模型
    - 模型流只接收已规范化的 LlmMessage
  files:
    - src/context.ts：从 Session record 筛选应用 Context
    - src/messages.ts：把应用 Message 转成 LlmMessage
    - src/conversation.ts：按选择、转换、请求的顺序运行一轮
diffFiles:
  - src/context.ts
  - src/messages.ts
  - src/conversation.ts
  - src/session.ts
---

# Chapter 5：从 Session 构建模型 Context

## 一两句话总结

Session 是完整、可恢复的事实日志，但模型只应看到本轮需要的消息。本章增加 `buildContext()` 与 `convertToLlm()` 两道边界：先从 Session record 选择应用消息，再把内容块规范化成模型输入。

## 为什么需要这一章

Chapter 4 恢复后直接把 `session.messages` 发送给模型，这在记录只有 user/assistant Message 时看似足够。一旦 Session 需要保存书签、界面提示、配置变化或扩展状态，“已持久化”就不再等于“应放进提示词”。

如果筛选和厂商 JSON 转换都藏在 provider 中，provider 就必须理解 Session record，Context 策略也会与 DeepSeek 格式耦合。本章把这三类数据拆开：

| 数据 | 负责什么 | 示例 |
| --- | --- | --- |
| `SessionRecord` | 保存发生过的事实 | `message`、`note` |
| 应用 `Message` | 表达对话语义和内容块 | `{ role, content: [{ type: "text", text }] }` |
| `LlmMessage` | 作为模型层的规范化输入 | `{ role, content: "文本" }` |

## 最小运行效果

离线测试构造三条 Session record：user Message、只给应用看的 note、assistant Message。恢复后 Session 仍有三条记录，但请求只包含两条模型消息：

```text
Session records: 3
Context messages: 2
LLM messages:
  user      "对模型可见"
  assistant "两个块：已合并"
```

运行测试：

```bash
pnpm --filter @x-pi/nano-pi test
pnpm --filter @x-pi/lab-chapter-05 test
```

## 数据流与边界

```text
session.jsonl
     |
     v
+-----------------------------+
| SessionRecord[]             |
| message | note | ...未来类型 |
+-----------------------------+
     | buildContext：选择
     | note -----------> 留在 Session，不进入模型
     v
+-----------------------------+
| Context                     |
| Message[] with content block|
+-----------------------------+
     | convertToLlm：转换
     v
+-----------------------------+
| LlmMessage[]                |
| role + string content       |
+-----------------------------+
     | provider：组装厂商请求
     v
DeepSeek /chat/completions JSON
```

选择发生在应用消息层，格式转换发生在模型边界，DeepSeek provider 只负责 URL、认证、请求外壳与响应解析。

## 分步实现

### 1. Session 保留完整 record

`src/session.ts` 将记录扩成可辨识联合：

```ts
type SessionRecord = MessageRecord | NoteRecord;

type NoteRecord = {
  type: "note";
  timestamp: string;
  text: string;
};
```

`Session.open()` 不再恢复后立刻丢掉 record 外壳，而是保留 `records`。`appendNote()` 证明一条记录可以值得持久化，却不属于模型对话。`messages` getter 仅用于兼容只关心对话的旧调用方；新 Context 路径读取 `records`。

解析器对每种 record 分别验证。未知类型或字段错误仍携带行号失败，避免把拼写错误静默当成“不进入 Context”。

### 2. `buildContext()` 只负责选择

完整实现位于 `src/context.ts`：

```ts
export function buildContext(records: readonly SessionRecord[]): Context {
  return {
    messages: records.flatMap((record) =>
      record.type === "message" ? [record.message] : []
    ),
  };
}
```

输入是持久化记录，输出仍是应用 `Message[]`。函数不会连接文本块，也不知道 DeepSeek 的 API；它只回答“哪些记录属于本轮对话上下文”。未来树形分支、compaction 和扩展记录都可以在这道边界演进。

当前线性实现按原顺序保留所有 message，并排除 note。它没有 token 截断策略，因为 Chapter 11 才会引入 compaction。

### 3. `convertToLlm()` 只负责转换

`src/messages.ts` 新增模型层的最小类型：

```ts
type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};
```

`convertToLlm()` 逐条保留角色，并用 `textOf()` 按顺序连接应用 Message 的文本块。它不再做 Session 筛选：调用它时，输入已经是 `buildContext()` 选出的消息。

这让两种变化互不干扰：新增 UI-only record 只改 Context 选择；新增模型可理解的内容类型才改转换规则。

### 4. Conversation 显式串起两道边界

`runTurn()` 在追加 user Message 后执行：

```ts
const context = buildContext(session.records);
const llmMessages = convertToLlm(context.messages);
for await (const event of streamModel(llmMessages, provider, options)) {
  // 消费统一模型事件
}
```

因此新 user 已经是 Session 事实，也会进入本轮 Context。若模型失败，它仍按 Chapter 4 的提交规则留在 Session；只有 `done` assistant 才会随后追加。

### 5. Provider 不再理解应用 Message

`streamModel()` 和 `ChatCompletionsApi.body()` 现在接收 `LlmMessage[]`。DeepSeek provider 直接把它放进请求的 `messages` 字段，只负责增加 `model` 和 `stream`：

```ts
body: (messages, model) => ({ model, messages, stream: true })
```

这仍是教学版简化。Pi 的模型 Message 还保留结构化 content，具体 provider 会进一步转换为厂商格式；Nano Pi 当前只有文本，因此用字符串 `content` 清楚展示转换结果。

## 关键代码解释

三道边界看起来比直接传数组多了两个函数，但每个函数都有单一判断：

- `Session.open()` 判断记录是否有效并恢复全部事实。
- `buildContext()` 判断哪些事实参与本轮模型上下文。
- `convertToLlm()` 判断应用内容如何成为模型可理解的消息。
- provider 判断规范消息如何装进厂商请求，以及厂商事件如何解析。

`note` 不是为了提前设计完整扩展系统，而是一个可运行的反例：如果只有 message record，测试无法证明 Context 层真的在选择。它没有进入 CLI，也不会污染正常对话。

## 端到端完整例子

假设 Session 依次保存：

```jsonl
{"type":"message","timestamp":"2026-09-19T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"解释 Context"}]}}
{"type":"note","timestamp":"2026-09-19T10:00:01.000Z","text":"用户在学习 Chapter 5"}
{"type":"message","timestamp":"2026-09-19T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Context "},{"type":"text","text":"负责选择。"}]}}
```

| 阶段 | 当前数据或状态 |
| --- | --- |
| Session 恢复 | 3 条 record，包含中间的 note |
| `buildContext()` | 2 条应用 Message，note 被排除 |
| `convertToLlm()` | `user("解释 Context")`、`assistant("Context 负责选择。")` |
| provider body | `{ model, messages: [...], stream: true }` |
| 磁盘状态 | 原来的 3 条 record 完整保留，没有因筛选被删除 |

注意“排除 Context”不是删除记录。应用仍可在恢复后读取 note，模型请求却看不到它。

## 错误与边界条件

- `message` record 必须包含合法 user/assistant 文本 Message。
- `note` record 必须包含字符串 `text`。
- 未知 record type 会明确报错，不会被无声跳过。
- `buildContext()` 保持 message 的 Session 顺序，并对空记录返回空消息列表。
- `convertToLlm()` 保持内容块顺序；空 content 数组会成为空字符串，当前不额外拒绝。
- 未完成尾行、已提交坏记录和模型失败的规则沿用 Chapter 4。
- 尚未处理 system、tool result、图片、分支、token 预算和 compaction。

## 运行和测试

```bash
node --test apps/nano-pi/test/*.test.ts
node --test labs/chapter-05/test/*.test.ts
./node_modules/.bin/tsc -p apps/nano-pi/tsconfig.json --noEmit
pnpm docs:build
```

新增测试会落盘并恢复一条 note，断言 Session 有 3 条 record，同时 `convertToLlm(buildContext(...).messages)` 只有 2 条消息，并验证两个 assistant 文本块按顺序合并。原有请求体测试继续验证最终 DeepSeek JSON。

## 与 Pi 源码的关系

本章于 2026-09-19 核对了 Pi 当前源码：

- `SessionManager` 的 `buildSessionContext()` 先沿活动分支构建 context entry，再用 `sessionEntryToContextMessages()` 得到 `AgentMessage[]`；它同时恢复 model 和 thinking 设置。
- agent loop 的 `transformContext` 在 `convertToLlm` 之前运行，用于裁剪历史或注入外部上下文。
- coding-agent 的 `convertToLlm()` 把 bash/custom/branch summary/compaction summary 转成 Pi AI Message，并过滤标记为不进入上下文的消息；标准 user/assistant/tool result 直接通过。
- custom Session entry 明确不参与 LLM context，custom message entry 才会参与。

Nano Pi 尚无线性历史以外的路径，也没有自定义 AgentMessage；因此 `buildContext()` 只筛选 record，`convertToLlm()` 只处理 user/assistant 文本。这保留了 Pi 的职责顺序，而没有提前搬入树、工具和 compaction。依据为 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)、[`messages.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/messages.ts) 和 [`agent/src/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)。

## 代码规模

- `context.ts` 18 行：Context 类型与 record 选择。
- `messages.ts` 新增约 14 行：`LlmMessage` 与 `convertToLlm()`。
- `session.ts` 新增约 35 行：record 联合、保留完整记录和 note 追加。
- `conversation.ts` 新增 3 行：显式串起选择与转换。

本章新增核心教学逻辑约 70 行。范围小于常见参考值，因为 JSONL 恢复、事件流和 provider 外壳已经由前几章建立；本章刻意只展示职责边界。

## 已知限制

- Context 仍包含线性历史中的全部 Message，没有长度预算。
- note 只有编程接口，没有 CLI 展示或编辑命令。
- `LlmMessage` 只支持 user/assistant 纯文本。
- Session 仍没有 id、parentId、活动 leaf 和版本 header。
- `convertToLlm()` 当前是同步纯函数，尚不需要异步扩展或错误降级约定。

## 下一章

Chapter 6 会把当前只运行一次的 `runTurn()` 提升为最小 Agent Loop：由 Agent 层拥有 turn 生命周期和稳定事件，而 CLI 不再直接编排一次模型调用。

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
- [x] 已保存对应的 `labs/chapter-05` 快照。
- [x] 已更新学习网站“源码与运行”的交互演示，并验证其中的源码、状态和命令与本章快照一致。
- [x] `pnpm docs:build` 成功，且本章“源码与运行”页签与 Chapter 01–04 具有相同的完整结构。
