---
order: 2
slug: message
title: Message 与内容块
summary: 用带角色的 Message 保存对话，并把流式文本积累成完整 assistant Message。
status: completed
lab: chapter-02
diffFrom: chapter-01
delta:
  concepts:
    - user/assistant Message 与文本 content block
    - 应用消息与模型请求格式分离
  behaviors:
    - 请求从裸 prompt 演进为完整 Message 历史
    - 流式输出同时积累为可保存的 assistant Message
  files:
    - src/messages.ts：消息类型、转换与响应积累
    - stream/provider/main：改用 Message[] 串起请求链路
diffFiles:
  - src/messages.ts
  - src/stream.ts
  - src/providers/deepseek.ts
  - src/main.ts
---

# Chapter 2：Message 与内容块

## 一两句话总结

单个字符串只能表示“有一段文字”，不能可靠说明是谁说的、由哪些内容组成，也不能保存一轮对话。Chapter 2 用带角色的 Message 和文本 content block 表示输入与输出：发送前转换成 DeepSeek 格式，接收时一边流式显示，一边累积成 assistant Message。

## 为什么需要这一章

Chapter 1 的入口是一个裸字符串：

```ts
streamText("介绍 SSE", deepSeekProvider, options)
```

它在只有一次用户输入时够用，但下面两个字符串本身没有区别：

```text
"介绍 SSE"
"SSE 是服务器推送技术。"
```

第一个是用户问题，第二个是 assistant 回答。若把它们存在 `string[]` 中，角色只能依赖数组位置猜测；中断、插入系统消息或加入工具结果后，这种猜测就会失效。字符串也无法在不改变整体表示的情况下加入图片、推理或工具调用。

因此本章先引入最小结构：

```ts
{
  role: "user",
  content: [{ type: "text", text: "介绍 SSE" }]
}
```

`role` 明确消息来源，`content` 数组给未来的其他内容块留出位置，`type` 让消费者能够区分块的含义。本章只支持 user、assistant 和 text；system、图片、工具调用留给真正需要它们的章节。

## 最小运行效果

运行方式没有变化：

```bash
pnpm --filter @x-pi/nano-pi start -- "用一句话介绍 Message"
```

终端仍逐块显示回答。不同之处在程序内部：输入先成为 user Message；所有文本块在 provider 边界转换成 DeepSeek 请求；完整响应最后成为 assistant Message，并追加到本轮 `messages` 数组。

## Message 转换和流式积累图

```text
CLI prompt
    |
    v
userMessage(prompt)
    |
    |  { role: "user", content: [{ type: "text", text: "..." }] }
    v
Message[] ------------------------------+
    |                                   |
    v                                   | append after [DONE]
deepSeekProvider.body()                 |
    |                                   |
    |  [{ role: "user", content: "..." }]
    v                                   |
HTTP / SSE -> text chunk -> onText()    |
                         \              |
                          +-> block.text += chunk
                                      |
                                      v
                           assistant Message
```

应用消息与厂商请求不是同一种数据。`Message[]` 是 Nano Pi 希望保存和继续扩展的格式；只有请求 DeepSeek 时，provider 才把文本块折叠成 API 当前接受的字符串 `content`。

## 分步实现

### 1. 定义最小 Message

完整代码在 `apps/nano-pi/src/messages.ts`：

```ts
export type TextContent = { type: "text"; text: string };

export type UserMessage = {
  role: "user";
  content: readonly TextContent[];
};

export type AssistantMessage = {
  role: "assistant";
  content: readonly TextContent[];
};
```

这里没有定义一个可填任意字符串的 `role`。字面量联合使 TypeScript 能在后续新增不同角色时检查每类消息的合法字段。`readonly` 允许 provider 读取历史，但阻止它改写消息的块数组。user 和 assistant 当前形状相同，仍分别命名，因为工具调用出现后 assistant 很可能拥有 user 没有的内容块。

`userMessage(text)` 把 CLI 字符串放进一个 text block。`textOf(message)` 把当前支持的所有文本块顺序连接起来：

```ts
export function textOf(message: Message): string {
  return message.content.map((block) => block.text).join("");
}
```

转换函数是显式边界，而不是让 HTTP 层到处读取 `content[0].text`。即使一条消息被拆成多个文本块，它们也能按原顺序发送。

### 2. 请求从 prompt 改为 Message[]

`TextProvider.body()` 与 `streamText()` 不再接收裸 prompt：

```ts
body(messages: readonly Message[], model: string): unknown;

streamText(messages, deepSeekProvider, options)
```

`readonly` 表示请求构造只能读取历史，不能偷偷改写应用状态。HTTP/SSE 层仍然只负责发送 provider 生成的 body 和解析网络流，它不理解具体消息字段。

### 3. 在 provider 边界转换

`apps/nano-pi/src/providers/deepseek.ts` 将应用 Message 转成 DeepSeek 的 OpenAI-compatible message：

```ts
messages: messages.map((message) => ({
  role: message.role,
  content: textOf(message),
}))
```

例如应用中的：

```json
{"role":"user","content":[{"type":"text","text":"介绍 SSE"}]}
```

会变成请求中的：

```json
{"role":"user","content":"介绍 SSE"}
```

这种分层很重要：以后应用消息可以包含 provider 不认识的元数据，或者不同 provider 可以使用不同请求格式，而 Session 和上层逻辑不需要随之变化。

### 4. 将文本增量积累成 assistant Message

`collectAssistantMessage()` 消费 Chapter 1 的 `AsyncIterable<string>`：

```ts
const block = { type: "text", text: "" };
const message = { role: "assistant", content: [block] };

for await (const text of stream) {
  onText(text);
  block.text += text;
}
return message;
```

每个 chunk 经过两条路径：`onText` 立即写到终端，保持流式体验；同一个 chunk 追加到 `block.text`，在 `[DONE]` 到达后返回完整消息。这里不为每个 chunk 创建一条 Message，因为网络分片没有业务含义，“服务”与“器推送”共同组成一条 assistant 回复。

`main.ts` 最后把结果追加到本轮数组：

```ts
const messages = [userMessage(prompt)];
const assistant = await collectAssistantMessage(
  streamText(messages, deepSeekProvider, options),
  (text) => process.stdout.write(text),
);
messages.push(assistant);
```

本章还没有 Session，因此进程结束后数组不会持久化。先让数据形状稳定，Chapter 4 再把它写入 JSONL。

## 端到端完整例子

假设已有两条历史消息，用户继续输入“介绍 SSE”，模型分两块返回“服务”和“器推送”：

| 阶段 | 当前数据或状态 |
| --- | --- |
| CLI 输入 | `介绍 SSE` |
| 应用历史 | `user("你好")`, `assistant("你好！")`, `user("介绍 SSE")` |
| DeepSeek 请求 | `messages: [{role:"user",content:"你好"}, {role:"assistant",content:"你好！"}, {role:"user",content:"介绍 SSE"}]` |
| SSE chunk 1 | 终端输出“服务”；assistant block 为 `"服务"` |
| SSE chunk 2 | 终端追加“器推送”；assistant block 为 `"服务器推送"` |
| `[DONE]` | 返回 `{role:"assistant", content:[{type:"text", text:"服务器推送"}]}` |
| 最终历史 | 原三条消息后追加完整 assistant Message |

测试使用内存 Response 完整演算了这条路径，因此不需要 API key，也不会产生模型费用。

## 错误与边界条件

- HTTP 错误、错误 content type、畸形 JSON、缺少 `[DONE]` 和 AbortSignal 传播仍沿用 Chapter 1 的处理。
- provider 收到 `readonly Message[]`，请求转换不会修改历史。
- 多个 text block 会按顺序连接，不依赖 `content[0]` 永远存在。
- 如果流在完成前失败，`collectAssistantMessage()` 不返回半成品消息；终端可能已显示部分文本，但本轮不会把它误当成完整回复。
- 合法但无文本的完整响应当前会产生一个空 text block。reasoning、拒答与其他内容类型要等统一模型事件引入后再区分。
- `onText` 是 Chapter 2 为保留即时输出使用的最小回调；Chapter 3 会用统一事件流替代它。

## 运行和测试

```bash
pnpm --filter @x-pi/nano-pi test
pnpm --filter @x-pi/lab-chapter-02 test
pnpm check
```

新增测试同时断言三件事：完整 Message 历史被正确转换成请求；两个响应 chunk 仍按到达顺序即时交给回调；最终只形成一个内容完整的 assistant Message。原有五个测试继续证明 SSE 分片、错误、取消和 provider 注入没有回归。

## 与 Pi 源码的关系

已核对的 Pi 设计中，Agent 可以持有应用侧 `AgentMessage`，调用模型前再通过 context 转换边界得到模型能理解的消息。Nano Pi 本章保留这个关键区别：`Message` 和 DeepSeek 请求对象不是同一类型。

本章是教学简化：只实现 user/assistant 文本消息，没有照搬 Pi 的完整 assistant 内容、usage、stop reason、timestamp、tool call 或 provider 事件结构。Chapter 3 会继续核对 `packages/ai`，把裸字符串增量演进成统一模型事件。

## 代码规模

- 新增 `messages.ts`：36 行。
- `stream.ts`、`deepseek.ts` 和 `main.ts` 的核心改动约 20 行。
- Chapter 2 新增或修改的核心教学逻辑合计约 56 行，低于 100–150 行目标。

测试和章节说明不计入核心教学代码。

## 已知限制

- CLI 每次仍只发起一轮请求，没有交互式多轮输入。
- Message 只存在内存中，尚未保存和恢复。
- content block 只有 text；没有 system、reasoning、图片或 tool call。
- provider 仍只产生文本、结束和忽略三类内部结果。
- 尚未定义稳定的模型事件，因此 UI 暂时通过回调接收文本。

## 下一章

现在应用已经能保存“完整消息”，但生成过程仍只是 `string` chunk：无法表达响应开始、内容更新、usage、结束原因或错误。Chapter 3 将引入统一模型事件流，并继续演进 provider、model 与 API 实现的边界。

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
- [x] 已保存对应的 `labs/chapter-02` 快照。
