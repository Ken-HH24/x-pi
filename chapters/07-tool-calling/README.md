---
order: 7
slug: tool-calling
title: Tool Calling 协议
summary: 把厂商的 tool_calls 增量组装成结构化内容块，并通过模型与 Agent 事件暴露完整生命周期。
status: completed
lab: chapter-07
diffFrom: chapter-06
delta:
  concepts:
    - Tool 声明、tool call 内容块与厂商协议转换
    - toolcall_start、toolcall_delta、toolcall_end 生命周期
  behaviors:
    - 跨 SSE chunk 累积并校验 JSON 参数
    - Agent 事件暴露工具调用增量与最终结构化状态
  files:
    - src/messages.ts：Tool、ToolCallContent 与模型消息
    - src/providers/deepseek.ts：DeepSeek tool_calls 双向转换
    - src/stream.ts：工具调用状态机与模型事件
diffFiles:
  - src/messages.ts
  - src/providers/deepseek.ts
  - src/stream.ts
  - src/agent.ts
  - test/deepseek.test.ts
---

# Chapter 7：Tool Calling 协议

## 一两句话总结

模型不会直接执行函数，而是流式产生“想调用哪个工具、参数是什么”的结构化请求。本章让 Nano Pi 能发送工具声明，把 DeepSeek 分散在多个 SSE chunk 中的 `tool_calls` 拼成 `ToolCallContent`，并向 Agent 消费者暴露调用的开始、增量与结束。

## 为什么需要这一章

Chapter 6 的 assistant 只有文本块，模型事件也只有文本增量。即使模型想读取文件，系统最多收到一句自然语言，无法可靠区分工具名、调用 id 和 JSON 参数，更无法把参数片段与并行调用对应起来。

工具协议涉及三层职责：应用层用厂商无关的 `Tool` 描述可用工具，provider 将它转换成 OpenAI-compatible JSON，模型流则按 `index` 累积每个工具调用的参数。本章只完成“表达和观察调用”，不执行 `read_file`，以免把协议解析和多轮控制混在一起。

## 最小运行效果

CLI 给模型声明一个 `read_file` 工具。模型选择文本回答时照常流式显示；选择工具时显示最终结构化调用：

```text
$ X_PI_SESSION_FILE=/tmp/x-pi-tool-call.jsonl \
  pnpm --filter @x-pi/lab-chapter-07 start -- "读取 README.md"

[tool call] read_file {"path":"README.md"}
```

这一输出表示协议组装完成，不表示文件已经读取。Session 中保存的是完整 assistant tool call，`turn_end.toolResults` 仍是空数组。

## 数据与事件流程图

```text
Tool[]                          DeepSeek SSE chunks
  |                                  |
  | tools: [{type:function,...}]      | index=0, id, name, args='{"path":'
  v                                  | index=0,           args='"README.md"}'
DeepSeek request                      v
                               ProviderEvent(tool_call)
                                      |
                                      v
                           calls: Map<index, accumulator>
                                      |
                 +--------------------+-------------------+
                 |                    |                   |
                 v                    v                   v
          toolcall_start       toolcall_delta*      toolcall_end
          contentIndex=0       raw JSON pieces       JSON.parse + object
                 |                    |                   |
                 +--------------------+-------------------+
                                      v
                     AssistantMessage.content[0]
                     { type: "toolCall", id, name,
                       arguments: { path: "README.md" } }
                                      |
                                      v
                     Agent message_update -> Session
```

`index` 是厂商流中一次调用的身份，`contentIndex` 是它在 assistant 内容数组中的位置。二者不能混用：文本块可能先进入数组，而且未来多个调用的事件可以交错。

## 分步实现

### 1. 定义厂商无关的工具与调用内容块

`src/messages.ts` 新增两种结构：

```ts
export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
```

`Tool` 是送给模型的能力声明；`ToolCallContent` 是模型返回的具体请求。参数只有在完整 JSON 解析成功后才进入最终内容块，因此 Session 不会保存半截字符串。

assistant 的模型消息还可以包含历史 `toolCalls`。`convertToLlm()` 保留应用内容块，到 DeepSeek provider 边界再转换成 `tool_calls[].function.arguments` 字符串。这延续了 Chapter 5 的职责：Context 做选择，模型转换做规范化，provider 才理解厂商字段名。

### 2. 在 provider 边界转换工具声明

`src/providers/deepseek.ts` 把教学版声明包进 OpenAI-compatible function tool：

```ts
{ type: "function", function: { name, description, parameters } }
```

没有工具时不发送 `tools` 字段，保持原有纯文本请求。assistant 历史中的结构化调用则转换回 `tool_calls[].function`，其中 arguments 用 `JSON.stringify()` 变成厂商要求的字符串。

### 3. 解析同一个 chunk 中的一个或多个调用增量

DeepSeek 的 `delta.tool_calls` 是数组，一次 SSE 事件可能包含多个元素。provider 因此允许一次 `parse()` 返回多个 `ProviderEvent`，SSE 层逐个展开。每个事件保留：

```ts
{ type: "tool_call", index, id?, name?, argumentsDelta }
```

通常第一片携带 `index / id / name`，后续片只带相同 `index` 和新的参数字符串。缺失的后续字段不是错误；但第一次看到某个 index 时必须有 id 和 name，否则无法建立稳定内容块。

### 4. 普通文本和 tool_call 是怎么区分的

两种数据都来自模型的 SSE 响应，但 DeepSeek 放在不同字段里。普通回答放在 `choices[0].delta.content`；工具调用放在 `choices[0].delta.tool_calls`。provider 读取字段后分别生成 `text` 和 `tool_call` 事件。随后 `streamModel()` 根据事件的 `type` 进入不同分支：文本追加到文本块，调用则按 `index` 累积参数。

例如，普通回答的一个 SSE 数据事件可能是：

```json
{"choices":[{"delta":{"content":"README.md 是项目说明文件。"}}]}
```

provider 会生成 `{ type: "text", text: "README.md 是项目说明文件。" }`，stream 收到它后走文本分支：

```ts
if (event.type === "text") {
  textBlock.text += event.text;
  yield { type: "text_delta", delta: event.text, partial };
}
```

最终 assistant 内容中对应一个文本块：

```ts
{ type: "text", text: "README.md 是项目说明文件。" }
```

工具调用则可能分成两个 SSE 数据事件。第一片带调用身份和部分参数：

```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}
```

第二片继续补参数，通常不再重复 id 和 name：

```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"README.md\"}"}}]}}]}
```

provider 将每个数组元素解析成 `{ type: "tool_call", index, id?, name?, argumentsDelta }`。stream 判断 `event.type === "tool_call"` 后按 `index` 找到同一次调用，把参数片段拼成 `{"path":"README.md"}`；收到 `[DONE]` 后才解析 JSON，得到最终内容块：

```ts
{
  type: "toolCall",
  id: "call_7",
  name: "read_file",
  arguments: { path: "README.md" },
}
```

所以判断依据是响应字段和解析出的事件类型，不是根据模型说了什么来猜。一个 SSE chunk 也可能同时含 `content` 和 `tool_calls`；provider 会按顺序生成两个事件，stream 分别处理，因此一次响应可以既有文本块，也有工具调用块。具体解析在 `src/providers/deepseek.ts`，按事件组装内容块的逻辑在 `src/stream.ts`。

### 5. 用 Map 保存每个调用的组装状态

一次回答可能包含多个工具调用，而且它们的参数片段可能交错到达。比如模型先开始调用 `read_file`，接着开始调用 `search`，然后才分别补齐两个调用的参数：

| 到达的增量 | Map 中发生的变化 | 发出的事件与当前消息 |
| --- | --- | --- |
| `index=0, id=call_A, name=read_file, arguments='{"path":'` | 为 `index=0` 新建状态，内容块放到 `content[0]`，原始参数为 `{"path":` | `toolcall_start(contentIndex=0)`，随后 `toolcall_delta(contentIndex=0, delta='{"path":')`。partial 中已有 `read_file` 块，但 `arguments` 仍为 `{}`。 |
| `index=1, id=call_B, name=search, arguments='{"query":'` | 为 `index=1` 新建另一份状态，内容块放到 `content[1]`，原始参数为 `{"query":` | `toolcall_start(contentIndex=1)`，随后 `toolcall_delta(contentIndex=1, delta='{"query":')`。partial 中现在有两个调用块。 |
| `index=0, arguments='"README.md"}'` | 用 `index=0` 找到 `call_A`，只把这段追加到它的原始参数 | `toolcall_delta(contentIndex=0, delta='"README.md"}')`。虽然上一个事件属于 `call_B`，这段仍会追加到 `read_file`。 |
| `index=1, arguments='"bug"}'` | 用 `index=1` 找到 `call_B`，追加它自己的参数 | `toolcall_delta(contentIndex=1, delta='"bug"}')`。 |
| 收到 `[DONE]` | 分别解析两份完整 JSON，并写入各自内容块 | 两个 `toolcall_end` 分别带 `contentIndex=0` 和 `contentIndex=1`；参数对象分别是 `{ path: "README.md" }` 和 `{ query: "bug" }`。 |

这里有两个编号，各有用途：provider 的 `index` 用来查找 Map 里同一个调用的累积状态；`contentIndex` 是该调用块在 assistant `content` 数组中的位置。事件可以交错，所以消费者应看事件携带的 `contentIndex` 来定位内容块，不能假定两个 `toolcall_start` 和 `toolcall_end` 之间只有同一个调用的事件。

核心状态大致如下，省略了错误检查和事件对象的其他字段：

```ts
const calls = new Map<number, {
  block: ToolCallContent;
  rawArguments: string;
  contentIndex: number;
}>();

// 第一次看见 index=0 时，创建调用块并记住它在 content 中的位置。
// 此时 rawArguments 还只是 JSON 的一部分，block.arguments 暂时是 {}。
calls.set(0, {
  block: { type: "toolCall", id: "call_A", name: "read_file", arguments: {} },
  rawArguments: "{\"path\":",
  contentIndex: 0,
});

// 后续片段带着 index=0 回来：只更新这次调用的原始参数，并发出新片段。
const call = calls.get(0)!;
call.rawArguments += "\"README.md\"}";
yield { type: "toolcall_delta", contentIndex: call.contentIndex,
  delta: "\"README.md\"}", partial };

// 收到 [DONE] 才 JSON.parse(call.rawArguments)，再写入 call.block.arguments。
```

`delta` 和 `partial` 不是两份相同的数据：`delta` 是这次新到达的参数字符串，例如 `"README.md"}`，适合直接追加到日志或流式界面；`partial` 是当前正在增长的 assistant 消息对象，里面有目前已创建的内容块。它是共享对象，不是冻结的历史快照。按本章的实现，未解析完成的参数保存在 Map 的 `rawArguments`，因此 `toolcall_delta` 期间 partial 里的 `arguments` 仍是 `{}`；参数只在完整 JSON 解析成功后写入块，并通过 `toolcall_end` 提供结构化结果。Agent 层的 `snapshot()` 会复制消息，避免已经发出的 Agent 事件被这个共享对象后续的变化改写。

### 6. 结束时严格形成结构化参数

收到 provider `done` 后，stream 按 `contentIndex` 顺序结束所有调用：

```ts
const args = JSON.parse(rawArguments || "{}");
if (!args || typeof args !== "object" || Array.isArray(args)) {
  throw new Error("arguments must be a JSON object");
}
block.arguments = args;
yield { type: "toolcall_end", contentIndex, toolCall: block, partial };
```

空参数规范化为 `{}`；损坏 JSON、数组、字符串或 null 都会失败，不产生 `done`，也不会提交 partial assistant。这里只验证“是 JSON object”，工具 schema 的参数校验属于执行前职责，留到 Chapter 8。

### 7. 把全部模型增量提升为 Agent 更新

这一节的变化发生在 **Agent 层**：模型流现在不仅有文本增量，也有 tool call 的开始、参数片段和完成事件；Agent 要把这些模型事件放进统一的 `message_update` 外壳，消费者才能在同一条 run / turn / message 生命周期里观察它们。

Chapter 6 的类型把更新事件限定为文本：

```ts
type TextDeltaEvent = Extract<ModelEvent, { type: "text_delta" }>;
// message_update.modelEvent 只能是 text_delta
```

Chapter 7 改为排除生命周期两端的 `start` 和 `done`，保留其余模型事件：

```ts
type UpdateModelEvent = Exclude<ModelEvent, { type: "start" } | { type: "done" }>;
// 因而包括 text_delta、toolcall_start、toolcall_delta、toolcall_end
```

Agent 对这些事件的处理规则很简单：模型流的 `start` 转成 Agent 的 `message_start`；每个中间事件（文本或 tool call）转成 `message_update`；模型流的 `done` 则提交完整 assistant message，并依次发出 `message_end`、`turn_end`、`agent_end`。例如用户请求读取文件时，关键事件顺序如下：

| 模型流事件 | Agent 发出的事件 | 读者可以观察到什么 |
| --- | --- | --- |
| `start` | `message_start` | assistant 消息开始，内容暂时为空 |
| `toolcall_start`, `contentIndex=0` | `message_update`, `modelEvent.type="toolcall_start"` | assistant 开始生成 `content[0]` 的工具调用 |
| `toolcall_delta`, `delta='{"path":'` | `message_update`, `modelEvent.type="toolcall_delta"` | 收到一段参数字符串；JSON 还不完整 |
| `toolcall_delta`, `delta='"README.md"}'` | `message_update`, `modelEvent.type="toolcall_delta"` | 参数片段已拼全，但仍等流结束后解析 |
| `toolcall_end`, 参数为 `{ path: "README.md" }` | `message_update`, `modelEvent.type="toolcall_end"` | 得到完整结构化调用 |
| `done` | `message_end` → `turn_end` → `agent_end` | assistant 消息保存；本章 `toolResults` 仍为空 |

`message_update` 里有两个容易混淆的字段。`modelEvent` 保留这一次具体的模型事件，例如 `toolcall_delta` 及其新增片段；`message` 则是 Agent 此刻的 assistant 消息副本，供通用消费者读取当前内容。`snapshot()` 会复制内容块和其中的 `arguments` 对象，所以之后把完整参数写入原始 partial 时，已经发出的 Agent `message` 不会跟着改变。需要注意，`modelEvent.partial` 仍是模型流传来的共享对象；稳定副本是 Agent 事件的 `message` 字段。

CLI 只看 Agent 事件，不处理 SSE、DeepSeek 字段或 `calls` Map。它只在 `message_update` 中再检查模型事件类型：文本事件打印新增文本；`toolcall_end` 打印工具名和完整参数。其他工具调用更新不打印，因此终端不会把半截 JSON 当成最终调用展示：

```ts
if (event.type === "message_update" && event.modelEvent.type === "text_delta") {
  process.stdout.write(event.modelEvent.delta);
} else if (event.type === "message_update" && event.modelEvent.type === "toolcall_end") {
  process.stdout.write(
    `\n[tool call] ${event.modelEvent.toolCall.name} ${JSON.stringify(event.modelEvent.toolCall.arguments)}`,
  );
}
```

因此这次输入最终显示为：

```text
[tool call] read_file {"path":"README.md"}
```

这行只说明 Agent 收到了完整调用请求。Chapter 7 没有执行 `read_file`，也没有生成工具结果，所以 `turn_end.toolResults` 仍是空数组；执行和发起下一轮模型请求留到 Chapter 8。

## 关键代码解释

provider 只做“厂商 JSON → 原子增量”，不尝试在单个 chunk 内解析完整 arguments，因为 JSON 字符串可以在任意字符处断开。stream 才拥有跨 chunk 生命周期，所以累积状态必须放在那里。

最终 Message 保存对象而不是原始 JSON 字符串，能让下一章执行器直接读取参数，也让 Session 恢复后保持类型明确。与此同时，`toolcall_delta.delta` 保留原始新增片段，使流式观察不需要反复序列化整个累计参数。

模型事件和 Agent 事件仍是两层：前者精确描述内容块如何增长，后者把这个增长放进 run / turn / message 生命周期。`turn_end.toolResults` 为空是刻意的协议证据：模型已经请求工具，但系统尚未执行。

## 端到端完整例子

| 阶段 | 当前数据或状态 |
| --- | --- |
| 输入 | 用户输入“读取 README.md”，请求携带 `read_file(path: string)` 声明 |
| SSE chunk 1 | `index=0, id=call_7, name=read_file, arguments='{"path":'` |
| `toolcall_start` | content[0] 是 `{ id: "call_7", name: "read_file", arguments: {} }` |
| 第一次 delta | Map 中 `rawArguments = '{"path":'` |
| SSE chunk 2 | `index=0, arguments='"README.md"}'` |
| 第二次 delta | Map 中 `rawArguments = '{"path":"README.md"}'` |
| `toolcall_end` | JSON 解析为 `{ path: "README.md" }`，写回 content[0] |
| Agent / Session | 提交完整调用；`turn_end.toolResults = []` |

## 错误与边界条件

- 首次出现的 tool call index 缺少 id 或 name时失败。
- 同一 index 后续改变 id 或 name 时失败，避免把两个调用合并。
- `tool_calls` 不是数组、index 不是非负整数、字段类型错误时由 provider 拒绝。
- 参数可跨网络 chunk 和 SSE 事件任意切分；只在 done 时解析。
- 参数必须是 JSON object；损坏 JSON 和数组等值不会提交 assistant。
- 同一 SSE chunk 中的文本和多个 tool call 会按 provider 解析顺序展开。
- 本章不做 JSON Schema 校验、不执行工具、不生成 tool result，也不发起第二个模型 turn。

## 运行和测试

```bash
node --test apps/nano-pi/test/*.test.ts
node --test labs/chapter-07/test/*.test.ts
./node_modules/.bin/tsc -p apps/nano-pi/tsconfig.json --noEmit
./node_modules/.bin/tsc -p labs/chapter-07/tsconfig.json --noEmit
pnpm docs:build
```

新增离线测试验证 Tool 声明转换、跨 chunk 参数组装、模型与 Agent 事件顺序、结构化 Session 恢复，以及损坏 JSON 和非 object 参数的失败路径。

## 与 Pi 源码的关系

本章于 2026-09-20 核对了 Pi 当前 `packages/ai` 与 `packages/agent`：`AssistantMessageEvent` 包含 `toolcall_start / toolcall_delta / toolcall_end` 并用 `contentIndex` 定位内容块；最终调用含 `id / name / arguments`，end 时结构完整但尚未做工具 schema 校验；不同内容块的事件可以交错；Agent 把模型事件包装为 `message_update`，工具执行另有独立生命周期。

Nano Pi 沿用这些边界，但仅实现 DeepSeek Chat Completions 的 function tool 子集，没有 thinking、自定义 grammar tool、usage、stop reason 或 partial JSON object parser。DeepSeek 官方文档确认其 Chat API 接受 function tools，实际函数仍需调用方提供和执行。

## 代码规模

- `messages.ts` 57 行：Tool、ToolCallContent 与规范模型消息。
- `providers/deepseek.ts` 106 行：请求转换和 tool_calls 增量验证。
- `stream.ts` 183 行：SSE、文本流及 tool call 状态机。
- `agent.ts` 79 行：统一提升文本与工具模型事件。

本章触及约 425 行核心文件，其中大量是前六章已有逻辑；真正新增复杂度集中在 provider 转换和约 60 行调用状态机。工具声明、流式解析、最终 Message 是同一协议的输入、过程和输出，继续拆章会留下无法端到端验证的半套结构。

## 已知限制

- `read_file` 只是声明，尚无实现，CLI 不会真的读取文件。
- 工具参数只检查 JSON object，尚不按 `parameters` schema 校验。
- 直到 `[DONE]` 才发出 toolcall_end；尚未利用 provider finish reason 提前收束。
- 没有 tool result Message，assistant tool call 后不能形成合法的下一轮工具上下文。
- 模型或协议失败仍通过异常表达，没有 Agent error 终态事件。

## 下一章

Chapter 8 将注册并执行工具，把结果追加成 tool result Message，然后重新构建 Context 发起下一次 turn，直到模型返回不含 tool call 的最终文本。

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
- [x] 已保存对应的 `labs/chapter-07` 快照。
- [x] 已更新学习网站“源码与运行”的交互演示。
- [x] `pnpm docs:build` 成功，且本章“源码与运行”页签具有完整结构。
