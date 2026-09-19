import type { AssistantMessage, Message, TextContent } from "./messages.ts";

export type ProviderEvent = { type: "text"; text: string }
  | { type: "done" } | { type: "ignore" };

export type Model = { id: string; api: "chat-completions" };

export type ChatCompletionsApi = {
  path: string;
  headers(apiKey: string): Record<string, string>;
  body(messages: readonly Message[], model: string): unknown;
  parse(data: string): ProviderEvent;
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
  | { type: "done"; message: AssistantMessage };

type StreamOptions = {
  apiKey: string;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch;
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
      const event = provider.api.parse(data);
      if (event.type !== "ignore") yield event;
      if (event.type === "done") return;
    }

    if (part.done) break;
  }

  throw new Error(`${provider.name} stream ended without a done event`);
}

export async function* streamModel(
  messages: readonly Message[], provider: ModelProvider, options: StreamOptions,
): AsyncGenerator<ModelEvent> {
  // 注入 provider 和 fetch：生产环境换模型，测试环境换网络实现。
  const request = options.fetch ?? globalThis.fetch;
  const model = options.model ?? provider.defaultModel.id;
  const response = await request(`${provider.baseUrl}${provider.api.path}`, {
    method: "POST",
    headers: provider.api.headers(options.apiKey),
    body: JSON.stringify(provider.api.body(messages, model)),
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

  const block: TextContent = { type: "text", text: "" };
  const partial: AssistantMessage = { role: "assistant", content: [block] };
  yield { type: "start", partial };

  for await (const event of parseSse(response.body, provider)) {
    if (event.type === "text") {
      // partial 是共享的“当前响应”；每个 delta 同时推进它。
      block.text += event.text;
      yield { type: "text_delta", delta: event.text, partial };
    } else if (event.type === "done") {
      yield { type: "done", message: partial };
    }
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
