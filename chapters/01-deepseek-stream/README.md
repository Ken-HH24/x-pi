---
order: 1
slug: deepseek-stream
title: 第一次 DeepSeek 流式请求
summary: 用原生 fetch、Web Streams 与可注入 Provider 正确消费 DeepSeek SSE 文本流。
status: completed
lab: chapter-01
delta:
  concepts:
    - SSE 事件边界与网络分片并不相同
    - Provider 隔离通用流处理与厂商协议
  behaviors:
    - 回答生成时逐块输出到终端
    - 支持 HTTP 错误、截断检测与 Ctrl+C 取消
  files:
    - src/stream.ts：HTTP、SSE 与 Async Generator
    - src/providers/deepseek.ts：DeepSeek 请求和响应转换
diffFiles:
  - src/stream.ts
  - src/providers/deepseek.ts
---

# Chapter 1：第一次 DeepSeek 流式请求

## 一句话总结

流式响应不是一次返回完整答案，而是 HTTP 连接持续送来 SSE 事件。Nano Pi 必须把任意网络分片重新拼成事件，再让注入的 provider 把厂商数据转换成统一的文本、结束或忽略事件。

## 最小运行效果

可以在仓库根目录创建 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-flash
```

`.env` 已被 Git 忽略。共享 `@x-pi/config` 会从当前目录向上查找最近的 `.env`。然后输入：

```bash
pnpm --filter @x-pi/nano-pi start -- "用一句话解释 SSE"
```

也可以不创建 `.env`，直接在当前 shell 中执行 `export DEEPSEEK_API_KEY="你的密钥"`。

终端不会等完整回答生成后一次打印，而会不断追加文本：

```text
SSE 是一种让服务器通过单个 HTTP 连接持续向客户端推送事件的协议。
```

## 模块流程图

```text
                      选择 provider
                  +--------------------+
                  |                    v
+------------+    |    +----------------------+     +------------------+
| CLI prompt | -> |    | deepSeekProvider     | --> | 请求与响应格式   |
+------------+    |    +----------------------+     +---------+--------+
                  |                                           |
                  v                                           |
             +----------+      POST       +--------------+    |
             | main.ts  | --------------> | streamText() | <--+
             +----+-----+                  +------+-------+
                  |                               |
                  |                               | HTTP SSE bytes
                  |                               v
                  |                        +-------------+
                  |                        | parseSse()  |
                  |                        +------+------+ 
                  |                               |
                  |                         text fragments
                  v                               v
             +------------------------------------------+
             |              Terminal output             |
             +------------------------------------------+

Ctrl+C -> SIGINT -> AbortController.abort() -> fetch / ReadableStream 取消
```

图里有三层职责：

- `main.ts` 处理命令行、环境变量、输出和 Ctrl+C。
- `stream.ts` 只处理通用 HTTP、ReadableStream 与 SSE 边界。
- `providers/deepseek.ts` 知道 DeepSeek 的 URL、请求体和 chunk 格式。

## 为什么先定义 Provider

Pi 并不会把 Agent 直接绑定到某一家模型。完整 Pi 的模型层还会区分 provider、model 和 API 实现；多个 provider 可以共享 OpenAI-compatible API，也可以使用完全不同的协议。

Chapter 1 先实现一个更小的注入边界：

```ts
type TextProvider = {
  name: string;
  url: string;
  defaultModel: string;
  headers(apiKey: string): Record<string, string>;
  body(prompt: string, model: string): unknown;
  parse(data: string): ProviderEvent;
};
```

它把变化分成两部分：

- `streamText()` 负责所有 provider 都需要的“发请求并消费 SSE”。
- provider 负责“请求发到哪里、请求长什么样、每个 data 表示什么”。

调用时显式注入：

```ts
streamText(prompt, deepSeekProvider, options)
```

因此 `streamText()` 不导入 DeepSeek，也不知道 `choices[0].delta.content`。测试中的 `demo` provider 甚至使用完全不同的请求体和事件内容，仍能复用同一流处理函数。

这还不是 Pi 的完整 provider registry。Chapter 3 会在引入统一模型事件时继续拆分“模型信息”和“API 协议实现”，并对照 Pi 当前的 Models/provider 机制。

## 先认清本章的六种数据

“流”“chunk”和“事件”很容易被混用。本章实际经过六种不同数据，它们的边界不能互换：

| 层级 | TypeScript 或协议形状 | 示例 | 谁负责处理 |
| --- | --- | --- | --- |
| 网络分片 | `Uint8Array` | 一段任意截断的 UTF-8 bytes | `TextDecoder` |
| 解码文本 | `string` | `data: {"choi` | `parseSse()` 的 buffer |
| SSE 事件 | 以空行结尾的一组字段 | `data: {...}\n\n` | `parseSse()` |
| SSE data | 从事件中取出的字符串 | `{"choices":[...]}` 或 `[DONE]` | `provider.parse()` |
| ProviderEvent | 内部可辨识联合 | `{ type: "text", text: "你" }` | `parseSse()` |
| 文本增量 | `string` | `"你"` | CLI |

对应的类型是：

```ts
type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "done" }
  | { type: "ignore" };
```

一条 DeepSeek 文本响应在各层的真实长相如下：

```text
网络 bytes
  64 61 74 61 3a 20 7b ...          Uint8Array
        |
        v TextDecoder
解码文本
  data: {"choices":[{"delta":{"content":"你"}}]}\n\n
        |
        v 按空行切分 SSE event
SSE data
  {"choices":[{"delta":{"content":"你"}}]}
        |
        v provider.parse(data)
ProviderEvent
  { type: "text", text: "你" }
        |
        v parseSse() yield
文本增量
  "你"
```

这里最关键的区别是：一次 `reader.read()` 得到的是网络分片，不是 SSE 事件；一个 SSE data 也不等于应用最终保存的 Message。本章只走到文本增量，Message 会在 Chapter 2 引入。

## 第一步：CLI 读取输入

`main.ts` 从 `process.argv` 读取问题：

```ts
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const prompt = args.join(" ").trim();
```

执行 pnpm script 时，参数分隔符 `--` 可能继续传给 Node，所以程序先移除它。若用户输入：

```bash
pnpm --filter @x-pi/nano-pi start -- "你好"
```

则关键中间值为：

```text
process.argv.slice(2) = ["--", "你好"]
args                    = ["你好"]
prompt                  = "你好"
```

API key 只从 `DEEPSEEK_API_KEY` 读取。应用加载统一的 `@x-pi/config/register`：它从当前目录向上查找最近的 `.env`，也接受 `ENV_FILE=/path/to/file`，因此不感知 monorepo 的固定层级。代码仓库只提供空的 `.env.example`，不会保存真实密钥。

## 第二步：选择并注入 DeepSeek Provider

`providers/deepseek.ts` 提供配置与三个转换函数。

请求地址和默认模型：

```ts
name: "deepseek",
url: "https://api.deepseek.com/chat/completions",
defaultModel: "deepseek-flash",
```

`headers(apiKey)` 把密钥转换成 HTTP header；`body(prompt, model)` 把简单字符串转换成 DeepSeek 当前接受的 OpenAI-compatible 请求：

```json
{
  "model": "deepseek-flash",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

`parse(data)` 则执行反向转换。它把厂商返回值压缩成三个内部事件：

```ts
{ type: "text", text: "你" }
{ type: "ignore" }
{ type: "done" }
```

DeepSeek 的单个 JSON data 使用下面的最小读取形状：

```ts
type DeepSeekChunk = {
  choices?: Array<{
    delta?: { content?: unknown };
  }>;
};
```

例如文本 data 是：

```json
{
  "choices": [
    {
      "delta": {
        "content": "你"
      }
    }
  ]
}
```

`content` 为 `null`、缺失或空字符串的 role、finish、reasoning 分片暂时是 `ignore`；文本 chunk 是 `text`；`[DONE]` 是 `done`。这样 SSE 层不需要认识 DeepSeek JSON，同时数字或对象等异常 content 类型仍会明确报错。

## 第三步：streamText 发起 HTTP 请求

`streamText()` 接收 prompt、provider 和 options：

```ts
streamText(prompt, deepSeekProvider, {
  apiKey,
  model: process.env.DEEPSEEK_MODEL,
  signal: controller.signal,
})
```

它按下面的顺序工作：

1. 使用注入的 `fetch`，没有注入时使用 Node.js 原生 `globalThis.fetch`。
2. 使用显式 model；没有设置时使用 `provider.defaultModel`。
3. 调用 `provider.headers()` 和 `provider.body()` 构建请求。
4. 把 AbortSignal 传给 fetch。
5. 检查 HTTP 状态、响应 body 和 `text/event-stream` content type。
6. 将响应体交给 `parseSse()`。

`fetch` 也是可注入依赖。离线测试可以提供 fake fetch，检查请求并返回内存中的 Response，不需要访问网络或消耗额度。

## 第四步：为什么不能一次 read 一个事件

`response.body` 是 `ReadableStream<Uint8Array>`。`reader.read()` 的边界由网络、缓冲区和运行时决定，与 SSE 事件边界没有对应关系。

服务器逻辑上发送：

```text
data: {"choices":[{"delta":{"content":"你"}}]}\n\n
```

客户端可能分两次收到：

```text
read 1 = data: {"choices":[{"del
read 2 = ta":{"content":"你"}}]}\n\n
```

如果每次 `read()` 都直接执行 `JSON.parse()`，第一次一定失败。因此解析器维护 `buffer`：

```ts
buffer += decoder.decode(part.value, { stream: !part.done });
const events = buffer.split(/\r?\n\r?\n/);
buffer = events.pop() ?? "";
```

这里每行都有意义：

- `TextDecoder` 把字节增量转换成字符串，也能正确处理被切开的多字节 UTF-8 字符。
- `split()` 只取已经出现空行结束符的完整事件。
- `pop()` 取出最后一个片段；它可能还不完整，因此重新放回 `buffer` 等下一次读取。

### 为什么 buffer 刚追加数据，又立刻被重新赋值

`buffer` 始终表示“已经收到，但还没有被完整处理的数据”。这三行代码完成的是一个循环：先把新分片拼到旧残片后面，再拿走其中的完整事件，最后只保留尚未完成的尾巴。

假设上一次读取后留下：

```text
buffer = data: {"content":"你
```

下一次网络读取返回：

```text
newText = 好"}\n\ndata: {"content":"世界
```

第一行代码相当于 `buffer = buffer + newText`：

```ts
buffer += newText;
```

此时得到：

```text
buffer = data: {"content":"你好"}\n\ndata: {"content":"世界
```

其中已经包含一个完整事件和一个不完整事件：

```text
+---------------------------+-------------------------+
| data: {"content":"你好"} | data: {"content":"世界 |
+---------------------------+-------------------------+
          完整事件                    未完成尾巴
```

按 SSE 空行切分后：

```ts
const events = buffer.split(/\r?\n\r?\n/);
```

结果是：

```ts
events = [
  'data: {"content":"你好"}',
  'data: {"content":"世界',
];
```

数组最后一项位于最后一个空行之后，可能还没有接收完整。`pop()` 将它从待处理事件中拿出来，重新保存为下一轮的 buffer：

```ts
buffer = events.pop() ?? "";
```

执行后：

```ts
events = ['data: {"content":"你好"}']; // 可以立即处理
buffer = 'data: {"content":"世界';     // 等待下一次 read()
```

因此，第二次给 `buffer` 赋值并没有丢掉刚收到的数据，而是在完整事件被取走之后，只保存当前无法处理的残片。

写成更显式的等价代码就是：

```ts
buffer += decoder.decode(part.value, { stream: !part.done });

const pieces = buffer.split(/\r?\n\r?\n/);
const incompleteEvent = pieces.pop();

buffer = incompleteEvent ?? "";
const completeEvents = pieces;
```

原实现中的 `events` 就是这里的 `completeEvents`。下一次 `read()` 会继续把新数据追加到残片后面，直到它也出现空行并成为完整事件。

## 第五步：从 SSE 事件取出 data

一个 SSE 事件可以包含注释、event、id 或多行 data。当前代码只收集 `data:`：

```ts
const data = rawEvent
  .split(/\r?\n/)
  .filter((line) => line.startsWith("data:"))
  .map((line) => line.slice(5).trimStart())
  .join("\n");
```

得到 data 后，解析器不自己解析 JSON，而是调用：

```ts
const event = provider.parse(data);
```

接下来只处理统一事件：

```ts
if (event.type === "done") return;
if (event.type === "text") yield event.text;
```

`yield` 使 `parseSse()` 成为 Async Generator。调用方每收到一段文字就可以立即输出，而不必等完整回答进入内存。

## 第六步：如何识别完整和异常响应

本章主动区分以下错误：

- HTTP 非成功状态，例如 401、429 或 503。
- 响应没有 body。
- content type 不是 `text/event-stream`。
- provider 无法解析事件 JSON。
- `delta.content` 存在但不是字符串。
- 连接关闭前没有收到 provider 的 `done` 事件。

最后一项最容易被忽略。TCP 或 HTTP 流正常关闭，只能说明连接结束，不能说明模型完成了回答。对于 DeepSeek 的当前格式，只有收到 `[DONE]` 才把响应视为完整。

错误体最多保留 500 个字符，防止代理服务器返回整张 HTML 页面把终端淹没。

## 第七步：Ctrl+C 如何一路取消到底

CLI 创建一个 `AbortController`：

```ts
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
```

signal 被传入 `streamText()`，然后原样传给 `fetch`。用户按 Ctrl+C 后，正在等待响应或读取 body 的操作会抛出 `AbortError`。CLI 单独识别它，打印 `Cancelled` 并设置退出码 130。

使用 `process.exitCode` 而不是立刻 `process.exit()`，可以让 Node 完成当前标准输出和资源清理。

## 完整演算：输入如何变成输出

假设用户执行：

```bash
pnpm --filter @x-pi/nano-pi start -- "只回答：你好"
```

整个过程如下：

| 阶段 | 当前数据 |
| --- | --- |
| CLI 参数 | `["--", "只回答：你好"]` |
| 清理后的 prompt | `"只回答：你好"` |
| provider | `deepSeekProvider` |
| model | `deepseek-flash` |
| 请求消息 | `{ role: "user", content: "只回答：你好" }` |
| 网络分片 1 | `data: {"choices":[{"delta":{"content":"你` |
| 此时 buffer | 仍是不完整事件，不产生输出 |
| 网络分片 2 | `"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n` |
| 第一个完整 data | `{"choices":[{"delta":{"content":"你"}}]}` |
| provider 事件 | `{ type: "text", text: "你" }` |
| 第一次终端输出 | `你` |
| 第二个 provider 事件 | `{ type: "text", text: "好" }` |
| 累计终端输出 | `你好` |
| 最后一个 SSE data | `[DONE]` |
| provider 事件 | `{ type: "done" }` |
| 最终输出 | `你好\n`，程序正常结束 |

注意：网络分片 1 和 2 是人为示例。真实网络可能在任意字节位置拆分，所以代码不能依赖固定分片方式。

## 离线测试

运行：

```bash
pnpm --filter @x-pi/nano-pi test
```

当前五个测试分别验证：

1. 包含 `content: null` 的角色分片被忽略，JSON 即使从中间切成两个网络分片仍能还原“你好”。
2. 坏 JSON 和缺少 done 事件会明确报错。
3. HTTP 429 的错误信息会传播，但不会包含请求密钥。
4. AbortSignal 会传到 fetch。
5. 注入一个请求体和响应格式都不同的 demo provider，通用流代码无需修改。

fixture 和 fake fetch 让测试完全离线，不消耗 DeepSeek API 额度。

## 与 Pi 源码的关系

本章和 Pi 共享的思想是：模型厂商细节不能泄漏到 Agent 和 UI。

但 Nano Pi 目前只有一个轻量 `TextProvider`；完整 Pi 还包括模型元数据、API 实现选择、统一 AssistantMessage 事件、reasoning、tool calls、usage、重试和多个认证方式。后续会按照问题出现的顺序补齐，而不是在第一章复制完整框架。

## 代码规模

- `src/main.ts`：38 行，处理参数、环境变量、输出和取消。
- `src/stream.ts`：82 行，处理通用 HTTP 与 SSE。
- `src/providers/deepseek.ts`：33 行，处理 DeepSeek 格式。

核心教学代码共 153 行，规模仍然集中；额外代码用于保留 provider 注入边界和必要注释。100–150 行只是复杂度参考，不是硬限制，测试与 fixture 也不机械计入核心教学代码。

## 已知限制

- 只接受一个用户字符串，没有多轮消息。
- Provider contract 目前只表达文本、忽略和结束事件。
- 忽略 reasoning、usage 和 tool calls。
- 没有超时、重试和退避策略。
- 没有 provider registry，只在组合入口显式注入。
- 没有使用 TypeScript 编译器做静态类型检查；Node.js 24 直接擦除可擦除类型并执行。

## 下一章

Chapter 2 将回答：为什么不能一直传字符串？我们会从真实请求和响应中提取 Message 与 content block，使用户消息、助手消息以及未来的工具结果拥有明确结构。
