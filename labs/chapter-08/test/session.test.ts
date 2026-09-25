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
import { ToolRegistry, type RegisteredTool } from "../src/tools.ts";

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
  registry = new ToolRegistry([]),
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    session,
    prompt,
    deepSeekProvider,
    { apiKey: "secret", fetch: fakeFetch },
    registry,
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
  const updates = events.flatMap((event) =>
    event.type === "message_update" && event.modelEvent.type === "text_delta"
      ? [{ delta: event.modelEvent.delta, text: textOf(event.message) }]
      : []
  );
  assert.deepEqual(updates.map((event) => event.delta), ["Agent ", "Loop"]);
  assert.deepEqual(updates.map((event) => event.text), ["Agent ", "Agent Loop"]);
  const turnEnd = events.find((event) => event.type === "turn_end");
  assert.deepEqual(turnEnd?.toolResults, []);
});

test("agent exposes tool call deltas and persists the structured call", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) return response(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]}}]}',
      "[DONE]",
    );
    assert.deepEqual(request.messages.at(-2)?.tool_calls, [{
      id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    }]);
    assert.deepEqual(request.messages.at(-1), { role: "tool", tool_call_id: "call_1", content: "README 内容" });
    return response('{"choices":[{"delta":{"content":"文件已读取"}}]}', "[DONE]");
  };
  const registry = new ToolRegistry([{
    name: "read_file", description: "读取", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    execute: () => "README 内容",
  }]);

  const events = await collectAgentEvents(session, "读取 README", fakeFetch, registry);
  const updates = events.filter((event) => event.type === "message_update").slice(0, 4);
  assert.deepEqual(updates.map((event) => event.modelEvent.type), [
    "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
  ]);
  const end = updates.at(-1);
  assert.deepEqual(
    end?.modelEvent.type === "toolcall_end" && end.modelEvent.toolCall,
    { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
  );
  const restored = await Session.open(path);
  assert.deepEqual(restored.messages.at(-3), {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call_1",
      name: "read_file",
      arguments: { path: "README.md" },
    }],
  });
  const turnEnd = events.find((event) => event.type === "turn_end");
  assert.equal(turnEnd?.toolResults[0]?.content, "README 内容");
  assert.equal(restored.messages.at(-1)?.role, "assistant");
});

test("tool failures become model-visible results and the loop continues", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) return response(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"fails","arguments":"{}"}}]}}]}',
      "[DONE]",
    );
    assert.deepEqual(request.messages.at(-1), {
      role: "tool", tool_call_id: "call_bad", content: "disk unavailable",
    });
    return response('{"choices":[{"delta":{"content":"工具暂不可用"}}]}', "[DONE]");
  };
  const registry = new ToolRegistry([{
    name: "fails", description: "throws", parameters: { type: "object" },
    execute: () => { throw new Error("disk unavailable"); },
  }]);
  const events = await collectAgentEvents(session, "执行", fakeFetch, registry);
  const failed = events.find((event) => event.type === "tool_execution_end");
  assert.equal(failed?.type === "tool_execution_end" && failed.result.isError, true);
  assert.equal(calls, 2);
  assert.equal((await Session.open(path)).messages.at(-2)?.role, "tool");
});

test("caps a run at five model turns", async () => {
  const session = await Session.open(await temporarySession());
  let requests = 0;
  let executions = 0;
  const fakeFetch: typeof fetch = async () => {
    requests++;
    return response(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `call_${requests}`,
        function: { name: "again", arguments: "{}" },
      }] } }] }),
      "[DONE]",
    );
  };
  const registry = new ToolRegistry([{
    name: "again", description: "repeat", parameters: { type: "object" },
    execute: () => { executions++; return "continue"; },
  }]);
  await assert.rejects(async () => {
    for await (const _event of runAgent(session, "循环", deepSeekProvider, {
      apiKey: "secret", fetch: fakeFetch,
    }, registry)) { /* consume the run */ }
  }, /five-turn tool loop limit/);
  assert.equal(requests, 5);
  assert.equal(executions, 5);
  assert.equal((await Session.open(session.path)).messages.at(-1)?.role, "tool");
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
