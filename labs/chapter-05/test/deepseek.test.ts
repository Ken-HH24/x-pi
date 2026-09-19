import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { convertToLlm, userMessage } from "../src/messages.ts";
import { deepSeekProvider } from "../src/providers/deepseek.ts";
import {
  parseSse,
  streamModel,
  type ModelEvent,
  type ModelProvider,
  type ProviderEvent,
} from "../src/stream.ts";

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

test("parses SSE even when JSON is split across network chunks", async () => {
  const fixture = await readFile(
    new URL("./fixtures/text.sse", import.meta.url),
    "utf8",
  );
  const middle = Math.floor(fixture.length / 2);
  assert.deepEqual(
    await collect(parseSse(body(fixture.slice(0, middle), fixture.slice(middle)), deepSeekProvider)),
    [{ type: "text", text: "你" }, { type: "text", text: "好" }, { type: "done" }],
  );
});

test("reports malformed JSON and truncated streams", async () => {
  await assert.rejects(
    () => collect(parseSse(body("data: nope\n\n"), deepSeekProvider)),
    /Invalid DeepSeek JSON/,
  );
  await assert.rejects(
    () => collect(parseSse(
      body('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
      deepSeekProvider,
    )),
    /ended without a done event/,
  );
});

test("reports HTTP errors without leaking request credentials", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('{"error":"rate limited"}', { status: 429 });
  await assert.rejects(
    () => collect(streamModel(convertToLlm([userMessage("hello")]), deepSeekProvider, {
      apiKey: "secret",
      fetch: fakeFetch,
    })),
    /HTTP 429.*rate limited/,
  );
});

test("forwards AbortSignal to fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const fakeFetch: typeof fetch = async (_input, init) => {
    if (init?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    return new Response();
  };
  await assert.rejects(
    () => collect(streamModel(convertToLlm([userMessage("hello")]), deepSeekProvider, {
      apiKey: "secret",
      signal: controller.signal,
      fetch: fakeFetch,
    })),
    { name: "AbortError" },
  );
});

test("uses the injected provider for request and response formats", async () => {
  const provider: ModelProvider = {
    id: "demo",
    name: "Demo",
    baseUrl: "https://example.test",
    defaultModel: { id: "demo-1", api: "chat-completions" },
    api: {
      path: "/generate",
      headers: () => ({ "x-demo": "yes" }),
      body: (messages, model) => ({ input: messages[0]!.content, model }),
      parse: (data): ProviderEvent => data === "end"
        ? { type: "done" }
        : { type: "text", text: data.toUpperCase() },
    },
  };
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, "https://example.test/generate");
    assert.deepEqual(JSON.parse(String(init?.body)), { input: "hello", model: "demo-1" });
    return new Response(body("data: hi\n\ndata: end\n\n"), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const events = await collect(streamModel(convertToLlm([userMessage("hello")]), provider, {
      apiKey: "unused",
      fetch: fakeFetch,
    }));
  assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
  assert.equal(events[1]?.type === "text_delta" && events[1].delta, "HI");
});

test("converts message blocks for the request and accumulates the response", async () => {
  const history = [
    { role: "user", content: [
      { type: "text", text: "你" },
      { type: "text", text: "好" },
    ] },
    { role: "assistant", content: [{ type: "text", text: "你好！" }] },
    userMessage("介绍 SSE"),
  ] as const;
  let requestBody: unknown;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(body(
      'data: {"choices":[{"delta":{"content":"服务"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"器推送"}}]}\n\n',
      "data: [DONE]\n\n",
    ), { headers: { "content-type": "text/event-stream" } });
  };
  const events = await collect<ModelEvent>(
    streamModel(convertToLlm(history), deepSeekProvider, { apiKey: "secret", fetch: fakeFetch }),
  );

  assert.deepEqual(requestBody, {
    model: "deepseek-flash",
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
      { role: "user", content: "介绍 SSE" },
    ],
    stream: true,
  });
  assert.deepEqual(events.map((event) => event.type), [
    "start", "text_delta", "text_delta", "done",
  ]);
  assert.deepEqual(events.flatMap((event) =>
    event.type === "text_delta" ? [event.delta] : []
  ), ["服务", "器推送"]);
  const done = events.at(-1);
  assert.deepEqual(done?.type === "done" && done.message, {
    role: "assistant",
    content: [{ type: "text", text: "服务器推送" }],
  });
});
