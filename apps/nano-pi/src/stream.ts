export type ProviderEvent = { type: "text"; text: string }
  | { type: "done" } | { type: "ignore" };

export type TextProvider = {
  name: string;
  url: string;
  defaultModel: string;
  headers(apiKey: string): Record<string, string>;
  body(prompt: string, model: string): unknown;
  parse(data: string): ProviderEvent;
};

type StreamOptions = {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
};

export async function* parseSse(
  body: ReadableStream<Uint8Array>, provider: TextProvider,
): AsyncGenerator<string> {
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
      const event = provider.parse(data);
      if (event.type === "done") return;
      if (event.type === "text") yield event.text;
    }

    if (part.done) break;
  }

  throw new Error(`${provider.name} stream ended without a done event`);
}

export async function* streamText(
  prompt: string, provider: TextProvider, options: StreamOptions,
): AsyncGenerator<string> {
  // 注入 provider 和 fetch：生产环境换模型，测试环境换网络实现。
  const request = options.fetch ?? globalThis.fetch;
  const model = options.model ?? provider.defaultModel;
  const response = await request(provider.url, {
    method: "POST",
    headers: provider.headers(options.apiKey),
    body: JSON.stringify(provider.body(prompt, model)),
    signal: options.signal,
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

  yield* parseSse(response.body, provider);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
