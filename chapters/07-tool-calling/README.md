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

### 4. 用 Map 组装交错的参数流

`src/stream.ts` 用 `Map<number, accumulator>` 按 provider index 保存状态：

```ts
const calls = new Map<number, {
  block: ToolCallContent;
  rawArguments: string;
  contentIndex: number;
}>();
```

第一次出现 index 时，把参数暂设为 `{}` 的 tool call 块加入共享 partial，并发出 `toolcall_start`。每个非空参数片段追加到 `rawArguments`，同时发出 `toolcall_delta`；事件的 `delta` 适合日志或增量 UI，共享 `partial` 则表示当前 assistant 状态。

采用 Map 而不是单个字符串，是因为两个 tool call 的 chunk 可以交错。消费者依赖 `contentIndex` 找内容块，也不能假定某个 start 到 end 之间没有其他块的事件。

### 5. 结束时严格形成结构化参数

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

### 6. 把全部模型增量提升为 Agent 更新

Chapter 6 的 `message_update` 只接受 `text_delta`。现在它接受 start/done 之外的全部模型事件，因此工具开始、参数增量和最终调用都会形成 Agent `message_update`。

`snapshot()` 会复制 tool call 的 `arguments`，防止后续完成解析时改写先前事件。CLI 分别处理文本和 `toolcall_end`；它仍不知道 SSE、DeepSeek 字段或累积 Map。

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
