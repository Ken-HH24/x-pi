import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgent, type AgentEvent } from "../src/agent.ts";
import { buildContext } from "../src/context.ts";
import { convertToLlm, textOf, userMessage } from "../src/messages.ts";
import { deepSeekProvider } from "../src/providers/deepseek.ts";
import { Session } from "../src/session.ts";

function response(...events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function temporarySession(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "x-pi-session-")), "session.jsonl");
}

async function collectAgentEvents(
  session: Session,
  prompt: string,
  fakeFetch: typeof fetch,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    session,
    prompt,
    deepSeekProvider,
    { apiKey: "secret", fetch: fakeFetch },
  )) {
    events.push(event);
  }
  return events;
}

test("opens missing and empty session files", async () => {
  const path = await temporarySession();
  assert.deepEqual((await Session.open(path)).messages, []);
  await writeFile(path, "");
  assert.deepEqual((await Session.open(path)).messages, []);
});

test("appends messages as JSONL and restores them", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.append(userMessage("第一轮"));
  await session.append({ role: "assistant", content: [{ type: "text", text: "回答" }] });

  const text = await readFile(path, "utf8");
  assert.equal(text.split("\n").filter(Boolean).length, 2);
  const restored = await Session.open(path);
  assert.deepEqual(restored.messages.map(textOf), ["第一轮", "回答"]);
});

test("builds model context from message records and excludes session notes", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.append(userMessage("对模型可见"));
  await session.appendNote("只给应用看的书签");
  await session.append({
    role: "assistant",
    content: [{ type: "text", text: "两个块：" }, { type: "text", text: "已合并" }],
  });

  const restored = await Session.open(path);
  const context = buildContext(restored.records);
  assert.equal(restored.records.length, 3);
  assert.deepEqual(convertToLlm(context.messages), [
    { role: "user", content: "对模型可见" },
    { role: "assistant", content: "两个块：已合并" },
  ]);
});

test("ignores an unfinished final line but reports committed corruption", async () => {
  const path = await temporarySession();
  const valid = JSON.stringify({
    type: "message",
    timestamp: "2026-09-19T00:00:00.000Z",
    message: userMessage("保留"),
  });
  await writeFile(path, `${valid}\n{"type":"mess`);
  assert.deepEqual((await Session.open(path)).messages.map(textOf), ["保留"]);

  await writeFile(path, `${valid}\nnot-json\n`);
  await assert.rejects(() => Session.open(path), /line 2/);
});

test("agent owns one turn, restores context, and persists only complete messages", async () => {
  const path = await temporarySession();
  const initial = await Session.open(path);
  await initial.append(userMessage("旧问题"));
  await initial.appendNote("恢复后仍不应发给模型");
  await initial.append({ role: "assistant", content: [{ type: "text", text: "旧回答" }] });

  const session = await Session.open(path);
  let requestMessages: Array<{ role: string; content: string }> = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requestMessages = JSON.parse(String(init?.body)).messages;
    return response('{"choices":[{"delta":{"content":"新回答"}}]}', "[DONE]");
  };
  const events = await collectAgentEvents(session, "新问题", fakeFetch);

  assert.deepEqual(requestMessages.map((message) => message.content), [
    "旧问题", "旧回答", "新问题",
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
  assert.deepEqual((await Session.open(path)).messages.map(textOf), [
    "旧问题", "旧回答", "新问题", "新回答",
  ]);
});

test("message updates expose immutable snapshots and text deltas", async () => {
  const session = await Session.open(await temporarySession());
  const fakeFetch: typeof fetch = async () => response(
    '{"choices":[{"delta":{"content":"Agent "}}]}',
    '{"choices":[{"delta":{"content":"Loop"}}]}',
    "[DONE]",
  );

  const events = await collectAgentEvents(session, "解释", fakeFetch);
  const updates = events.filter((event) => event.type === "message_update");
  assert.deepEqual(updates.map((event) => event.modelEvent.delta), ["Agent ", "Loop"]);
  assert.deepEqual(updates.map((event) => textOf(event.message)), ["Agent ", "Agent Loop"]);
  const turnEnd = events.find((event) => event.type === "turn_end");
  assert.deepEqual(turnEnd?.toolResults, []);
});

test("keeps the user message but not a partial assistant after failure", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  const fakeFetch: typeof fetch = async () => response(
    '{"choices":[{"delta":{"content":"半条"}}]}',
  );

  await assert.rejects(
    async () => {
      for await (const _event of runAgent(
        session,
        "会失败",
        deepSeekProvider,
        { apiKey: "secret", fetch: fakeFetch },
      )) {
        // 消费完整事件流以触发底层错误。
      }
    },
    /without a done event/,
  );
  assert.deepEqual((await Session.open(path)).messages.map(textOf), ["会失败"]);
});
