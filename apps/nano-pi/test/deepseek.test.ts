import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
    () => collect(streamText("hello", deepSeekProvider, {
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
    () => collect(streamText("hello", deepSeekProvider, {
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
    body: (prompt, model) => ({ input: prompt, model }),
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
    await collect(streamText("hello", provider, { apiKey: "unused", fetch: fakeFetch })),
    "HI",
  );
});
