---
order: 3
slug: model-events
title: 统一模型事件流
summary: 把厂商 SSE 增量转成 start、text_delta 和 done，让消息构建与终端渲染共用同一条语义清晰的流。
status: completed
lab: chapter-03
diffFrom: chapter-02
delta:
  concepts:
    - Provider、Model 与 API 实现的最小分层
    - 模型生成的开始、文本增量和完成事件
  behaviors:
    - 终端只渲染 text_delta，不再直接消费裸字符串
    - assistant Message 与事件流同步增长，done 携带最终消息
  files:
    - src/stream.ts：统一事件、Provider/Model/API 边界与流状态
    - src/providers/deepseek.ts：DeepSeek provider 组合 OpenAI-compatible API
    - src/main.ts：按事件类型渲染和保存结果
diffFiles:
  - src/stream.ts
  - src/providers/deepseek.ts
  - src/main.ts
---

# Chapter 3：统一模型事件流

## 一两句话总结

`AsyncIterable<string>` 只能说“又来了一段文字”，无法表达响应何时开始、何时完整结束。Chapter 3 将 DeepSeek 的 SSE 数据转为最小的厂商无关事件：`start`、`text_delta` 和 `done`。

## 为什么需要这一章

Chapter 2 把文本 chunk 一边交给回调一边累积为 Message。这在纯文本时可用，但一个字符串不能区分：

- 这是响应的第一块，还是中间的一块？
- 流是正常完成，还是网络提前断开？
- 未来的 reasoning 和 tool call 是否也要假装成文本？

因此 UI 不应把“异步迭代结束”猜成“模型正常完成”。正常完成必须由显式 `done` 事件表达，缺少 done 仍然是协议错误。

## 最小运行效果

```bash
pnpm --filter @x-pi/nano-pi start -- "用一句话介绍事件流"
```

终端的视觉效果与上一章一样，文本仍然逐块出现。内部数据已变成：

```text
start -> text_delta("事件") -> text_delta("流") -> done
```

## Provider、Model、API 与事件流

```text
Message[] + Model id
         |
         v
ModelProvider (DeepSeek: base URL, default model)
         |
         v
ChatCompletionsApi (path, headers, body, parse)
         |
         v
HTTP response -> SSE data -> ProviderEvent
                              text | done | ignore
                                 |
                                 v
                    shared partial AssistantMessage
                                 |
              +------------------+----------------+
              v                  v                v
           start          text_delta(delta)    done(message)
                                 |
                     terminal writes delta
```

Provider 表示服务商，Model 表示具体模型，API 实现负责请求和响应协议。DeepSeek 的 provider 可以复用 chat-completions API，而不需要把这三个概念合并成一个巨大适配器。

## 分步实现

### 1. 定义最小模型事件

完整代码在 `apps/nano-pi/src/stream.ts`：

```ts
export type ModelEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "done"; message: AssistantMessage };
```

`type` 是可辨识联合的判别字段。消费者在 `switch` 或 `if` 中检查它后，TypeScript 会知道该事件有 `delta`、`partial` 还是 `message`。这使未来增加 thinking 和 tool call 时不需要约定特殊字符串。

### 2. 分开 Provider、Model 和 API

```ts
export type Model = { id: string; api: "chat-completions" };

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: Model;
  api: ChatCompletionsApi;
};
```

`deepSeekProvider` 只声明服务商信息和默认模型，再组合 `chatCompletionsApi`。API 对象负责 `/chat/completions` 路径、认证 header、body 转换与 SSE data 解析。

这是最小分层：只有一种 API 和一个默认 Model，没有提前引入 registry、动态模型列表或认证存储。

### 3. SSE 只切分和转交厂商事件

`parseSse()` 现在产生 `ProviderEvent`，不再产生裸文本。它仍保留上一章的网络分片缓冲、多行 data、畸形 JSON 报错与缺少 done 检查。

`ignore` 只是 provider 内部结果，例如只包含 role 的 DeepSeek chunk。它不是应用层事件，所以在 SSE 边界被丢弃。

### 4. 用事件推进共享 partial

```ts
const block = { type: "text", text: "" };
const partial = { role: "assistant", content: [block] };
yield { type: "start", partial };

// 收到 provider text 后
block.text += event.text;
yield { type: "text_delta", delta: event.text, partial };
```

`partial` 是正在生长的同一个 Message，不是每个事件的历史快照。这避免每个 chunk 都复制已生成文本。当 provider 明确发出 done，流产生 `{ type: "done", message: partial }`。

### 5. 终端只关心它需要的事件

```ts
for await (const event of streamModel(messages, deepSeekProvider, options)) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "done") messages.push(event.message);
}
```

CLI 不读 DeepSeek JSON，也不自己拼接响应。它用 delta 做即时渲染，只在 done 后把完整消息加入历史。

## 端到端完整例子

DeepSeek 分两块返回“服务”和“器推送”：

| 阶段 | 当前数据或状态 |
| --- | --- |
| CLI 输入 | `介绍 SSE` 变为 user Message |
| Provider | 选中 `deepseek-flash` 与 `chat-completions` API |
| 请求转换 | content block 折叠为 `{role:"user", content:"介绍 SSE"}` |
| 响应就绪 | `start` 携带空 assistant partial |
| SSE chunk 1 | `text_delta("服务")`；终端输出“服务”；partial 为“服务” |
| SSE chunk 2 | `text_delta("器推送")`；终端追加“器推送”；partial 为“服务器推送” |
| `[DONE]` | `done` 携带完整 assistant Message，然后追加到历史 |

## 错误与边界条件

- HTTP 错误、非 SSE 响应、畸形 JSON、缺少 done 和 AbortSignal 传播语义保持不变。
- `start` 只在 HTTP 响应通过状态码、body 和 content type 检查后产生。
- 响应可以没有 text delta；只要收到 done，最终就是合法的空文本 Message。
- 中断或协议错误会抛出异常，不产生 done，因此 CLI 不会保存半条回复。
- Pi 把失败也编码成 `error` 终止事件；Nano Pi 暂时保留抛异常，等后续 Agent Loop 需要统一状态时再演进。

## 运行和测试

```bash
pnpm --filter @x-pi/nano-pi test
pnpm --filter @x-pi/lab-chapter-03 test
pnpm check
```

6 个离线测试覆盖：跨网络分片的 SSE、畸形与截断流、HTTP 错误、取消传播、可注入 provider，以及 `start -> text_delta -> done` 的顺序和最终 Message。

## 与 Pi 源码的关系

本章核对了 Pi 当前 `packages/ai`：

- [`types.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) 的 `AssistantMessageEvent` 定义了 start、text/thinking/tool-call 生命周期以及 done/error。
- [`providers/deepseek.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/deepseek.ts) 使 DeepSeek provider 组合 `openAICompletionsApi`，而不重写一套 API 实现。
- [`models.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts) 中 provider 持有 model 列表和 stream 行为，并按 `model.api` 选择 API 实现。
- [`utils/event-stream.ts`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/event-stream.ts) 让同一条流既能异步迭代事件，也能取得最终 AssistantMessage。

Nano Pi 保留的核心是：厂商协议先转成统一事件，响应通过共享 partial 渐进构建，应用层不依赖厂商 JSON。教学版暂时省略了 text_start/text_end、thinking、tool call、usage、stop reason、事件队列的 `result()` 和认证 registry。

## 代码规模

- `stream.ts` 109 行，包含类型、SSE 解析、HTTP 检查和统一事件构建。
- 相比 Chapter 2，核心实现净增量低于 100 行。

## 已知限制

- 只有文本事件，没有 reasoning、tool call、usage 和 stop reason。
- 只配置一个 DeepSeek model，没有 model registry 或动态发现。
- `partial` 是可变的共享对象；如果要保存事件时刻的快照，消费者必须自行复制。
- 事件流还没有被 Agent Loop 消费。

## 下一章

Chapter 4 将引入 Session 和 JSONL。现在 done 已能明确给出完整 assistant Message，下一步就是将 user/assistant 消息以可追加、可恢复的方式持久化。

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
- [x] 已保存对应的 `labs/chapter-03` 快照。
