import { textOf } from "../messages.ts";
import type { ChatCompletionsApi, ModelProvider } from "../stream.ts";

type DeepSeekChunk = { choices?: Array<{ delta?: { content?: unknown } }> };

const chatCompletionsApi: ChatCompletionsApi = {
  path: "/chat/completions",
  headers: (apiKey) => ({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }),
  body: (messages, model) => ({
    model,
    // 应用消息保留 content block；到 provider 边界才转换成厂商格式。
    messages: messages.map((message) => ({
      role: message.role,
      content: textOf(message),
    })),
    stream: true,
  }),
  parse(data) {
    if (data === "[DONE]") return { type: "done" };
    let chunk: DeepSeekChunk;
    try {
      chunk = JSON.parse(data) as DeepSeekChunk;
    } catch {
      throw new Error(`Invalid DeepSeek JSON: ${data}`);
    }
    const content = chunk.choices?.[0]?.delta?.content;
    // DeepSeek 的角色、结束或 reasoning 分片可能没有文本，content 会是 null。
    if (content == null || content === "") return { type: "ignore" };
    if (typeof content !== "string") {
      throw new Error("Invalid DeepSeek chunk: delta.content is not text");
    }
    return { type: "text", text: content };
  },
};

export const deepSeekProvider: ModelProvider = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  defaultModel: { id: "deepseek-flash", api: "chat-completions" },
  api: chatCompletionsApi,
};
