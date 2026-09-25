import type {
  AssistantMessage,
  LlmMessage,
  TextContent,
  Tool,
  ToolCallContent,
} from "./messages.ts";

export type ProviderEvent = { type: "text"; text: string }
  | {
    type: "tool_call";
    index: number;
    id?: string;
    name?: string;
    argumentsDelta: string;
  }
  | { type: "done" } | { type: "ignore" };

export type Model = { id: string; api: "chat-completions" };

export type ChatCompletionsApi = {
  path: string;
  headers(apiKey: string): Record<string, string>;
  body(messages: readonly LlmMessage[], model: string, tools: readonly Tool[]): unknown;
  parse(data: string): ProviderEvent | readonly ProviderEvent[];
};

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: Model;
  api: ChatCompletionsApi;
};

export type ModelEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  | { type: "done"; message: AssistantMessage };

export type StreamOptions = {
  apiKey: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch;
  tools?: readonly Tool[] | undefined;
};

export async function* parseSse(
  body: ReadableStream<Uint8Array>, provider: ModelProvider,
): AsyncGenerator<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const part = await reader.read();
    // 网络分片不等于 SSE 事件：半个事件必须留到下一次 read() 再拼。
    buffer += decoder.decode(part.value, { stream: !part.done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;

      // SSE 层只负责切事件；事件含义交给注入的 provider 解释。
      const parsed = provider.api.parse(data);
      const providerEvents = Array.isArray(parsed) ? parsed : [parsed];
      for (const event of providerEvents) {
        if (event.type !== "ignore") yield event;
        if (event.type === "done") return;
      }
    }

    if (part.done) break;
  }

  throw new Error(`${provider.name} stream ended without a done event`);
}

export async function* streamModel(
  messages: readonly LlmMessage[], provider: ModelProvider, options: StreamOptions,
): AsyncGenerator<ModelEvent> {
  // 注入 provider 和 fetch：生产环境换模型，测试环境换网络实现。
  const request = options.fetch ?? globalThis.fetch;
  const model = options.model ?? provider.defaultModel.id;
  const response = await request(`${provider.baseUrl}${provider.api.path}`, {
    method: "POST",
    headers: provider.api.headers(options.apiKey),
    body: JSON.stringify(provider.api.body(messages, model, options.tools ?? [])),
    signal: options.signal ?? null,
  });

  if (!response.ok) {
    // 限制错误体长度，避免代理返回的大页面淹没终端。
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${provider.name} HTTP ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error(`${provider.name} response has no body`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`${provider.name} response is not an SSE stream`);
  }

  const content: Array<TextContent | ToolCallContent> = [];
  const partial: AssistantMessage = { role: "assistant", content };
  let textBlock: TextContent | undefined;
  const calls = new Map<number, { block: ToolCallContent; rawArguments: string; contentIndex: number }>();
  yield { type: "start", partial };

  for await (const event of parseSse(response.body, provider)) {
    if (event.type === "text") {
      textBlock ??= (() => {
        const block: TextContent = { type: "text", text: "" };
        content.push(block);
        return block;
      })();
      // partial 是共享的“当前响应”；每个 delta 同时推进它。
      textBlock.text += event.text;
      yield { type: "text_delta", delta: event.text, partial };
    } else if (event.type === "tool_call") {
      let call = calls.get(event.index);
      if (!call) {
        if (!event.id || !event.name) {
          throw new Error(`Tool call ${event.index} started without id or name`);
        }
        const block: ToolCallContent = {
          type: "toolCall",
          id: event.id,
          name: event.name,
          arguments: {},
        };
        content.push(block);
        call = { block, rawArguments: "", contentIndex: content.length - 1 };
        calls.set(event.index, call);
        yield { type: "toolcall_start", contentIndex: call.contentIndex, partial };
      }
      if (event.id && event.id !== call.block.id || event.name && event.name !== call.block.name) {
        throw new Error(`Tool call ${event.index} changed identity while streaming`);
      }
      if (event.argumentsDelta) {
        call.rawArguments += event.argumentsDelta;
        yield {
          type: "toolcall_delta",
          contentIndex: call.contentIndex,
          delta: event.argumentsDelta,
          partial,
        };
      }
    } else if (event.type === "done") {
      for (const call of [...calls.values()].sort((a, b) => a.contentIndex - b.contentIndex)) {
        let args: unknown;
        try {
          args = JSON.parse(call.rawArguments || "{}");
        } catch {
          throw new Error(`Invalid JSON arguments for tool ${call.block.name}`);
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new Error(`Tool ${call.block.name} arguments must be a JSON object`);
        }
        call.block.arguments = args as Record<string, unknown>;
        yield {
          type: "toolcall_end",
          contentIndex: call.contentIndex,
          toolCall: call.block,
          partial,
        };
      }
      yield { type: "done", message: partial };
    }
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
