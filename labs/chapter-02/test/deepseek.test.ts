import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectAssistantMessage, textOf, userMessage } from "../src/messages.ts";
import { deepSeekProvider } from "../src/providers/deepseek.ts";
import { parseSse, streamText, type TextProvider } from "../src/stream.ts";

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const text of stream) result += text;
  return result;
}

test("parses SSE even when JSON is split across network chunks", async () => {
  const fixture = await readFile(
    new URL("./fixtures/text.sse", import.meta.url),
    "utf8",
  );
  const middle = Math.floor(fixture.length / 2);
  assert.equal(
    await collect(parseSse(body(fixture.slice(0, middle), fixture.slice(middle)), deepSeekProvider)),
    "你好",
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
    () => collect(streamText([userMessage("hello")], deepSeekProvider, {
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
    () => collect(streamText([userMessage("hello")], deepSeekProvider, {
      apiKey: "secret",
      signal: controller.signal,
      fetch: fakeFetch,
    })),
    { name: "AbortError" },
  );
});

test("uses the injected provider for request and response formats", async () => {
  const provider: TextProvider = {
    name: "demo",
    url: "https://example.test/generate",
    defaultModel: "demo-1",
    headers: () => ({ "x-demo": "yes" }),
    body: (messages, model) => ({ input: textOf(messages[0]!), model }),
    parse: (data) => data === "end"
      ? { type: "done" }
      : { type: "text", text: data.toUpperCase() },
  };
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, provider.url);
    assert.deepEqual(JSON.parse(String(init?.body)), { input: "hello", model: "demo-1" });
    return new Response(body("data: hi\n\ndata: end\n\n"), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  assert.equal(
    await collect(streamText([userMessage("hello")], provider, {
      apiKey: "unused",
      fetch: fakeFetch,
    })),
    "HI",
  );
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
  const chunks: string[] = [];
  const assistant = await collectAssistantMessage(
    streamText(history, deepSeekProvider, { apiKey: "secret", fetch: fakeFetch }),
    (text) => chunks.push(text),
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
  assert.deepEqual(chunks, ["服务", "器推送"]);
  assert.deepEqual(assistant, {
    role: "assistant",
    content: [{ type: "text", text: "服务器推送" }],
  });
});
