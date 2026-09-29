import type { LlmMessage, Tool } from "../messages.ts";
import type { ChatCompletionsApi, ModelProvider, ProviderEvent } from "../stream.ts";

type DeepSeekToolCallDelta = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type DeepSeekChunk = {
  choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>;
};

/** 将规范模型消息转换成 OpenAI-compatible 的 DeepSeek 消息。 */
function messagesForDeepSeek(messages: readonly LlmMessage[]): unknown[] {
  return messages.map((message) => message.role === "user" ? message : message.role === "tool" ? {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.content,
  } : {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls ? {
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    } : {}),
  });
}

/** 将教学版 Tool 声明转换成 DeepSeek 接受的 function tool。 */
function toolsForDeepSeek(tools: readonly Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: tool,
  }));
}

const chatCompletionsApi: ChatCompletionsApi = {
  path: "/chat/completions",
  headers: (apiKey) => ({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }),
  body: (messages, model, tools) => ({
    model,
    // Context 已转换成模型消息；此处只组装 DeepSeek 的请求外壳。
    messages: messagesForDeepSeek(messages),
    ...(tools.length > 0 ? { tools: toolsForDeepSeek(tools) } : {}),
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
    const delta = chunk.choices?.[0]?.delta;
    const content = delta?.content;
    // DeepSeek 的角色、结束或 reasoning 分片可能没有文本，content 会是 null。
    const events: ProviderEvent[] = [];
    if (content != null && content !== "") {
      if (typeof content !== "string") {
        throw new Error("Invalid DeepSeek chunk: delta.content is not text");
      }
      events.push({ type: "text", text: content });
    }

    if (delta?.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) {
        throw new Error("Invalid DeepSeek chunk: delta.tool_calls is not an array");
      }
      for (const value of delta.tool_calls as DeepSeekToolCallDelta[]) {
        if (!Number.isInteger(value.index) || (value.index as number) < 0) {
          throw new Error("Invalid DeepSeek tool call: index is not a non-negative integer");
        }
        const id = value.id;
        const name = value.function?.name;
        const argumentsDelta = value.function?.arguments;
        if (id != null && typeof id !== "string" || name != null && typeof name !== "string" ||
            argumentsDelta != null && typeof argumentsDelta !== "string") {
          throw new Error("Invalid DeepSeek tool call delta");
        }
        events.push({
          type: "tool_call",
          index: value.index as number,
          ...(id != null ? { id } : {}),
          ...(name != null ? { name } : {}),
          argumentsDelta: argumentsDelta ?? "",
        });
      }
    }

    if (events.length === 0) return { type: "ignore" };
    if (events.length === 1) return events[0]!;
    return events;
  },
};

export const deepSeekProvider: ModelProvider = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  defaultModel: { id: "deepseek-flash", api: "chat-completions" },
  api: chatCompletionsApi,
};
