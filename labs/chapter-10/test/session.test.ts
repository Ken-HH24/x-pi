import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resumeAgent, runAgent, type AgentEvent } from "../src/agent.ts";
import { buildContext } from "../src/context.ts";
import { findPendingTurn } from "../src/recovery.ts";
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
  await session.appendMessage(userMessage("第一轮"));
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "回答" }] });

  const text = await readFile(path, "utf8");
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  const restored = await Session.open(path);
  assert.deepEqual(restored.messages.map(textOf), ["第一轮", "回答"]);
});

test("builds model context from message records and excludes session notes", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("对模型可见"));
  await session.appendNote("只给应用看的书签");
  await session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "两个块：" }, { type: "text", text: "已合并" }],
  });

  const restored = await Session.open(path);
  const context = buildContext(restored);
  assert.equal(restored.entries.length, 3);
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
  await initial.appendMessage(userMessage("旧问题"));
  await initial.appendNote("恢复后仍不应发给模型");
  await initial.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧回答" }] });

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
  const start = updates[0];
  assert.deepEqual(start?.type === "message_update" && start.modelEvent.partial.content[0], {
    type: "toolCall", id: "call_1", name: "read_file", arguments: {},
  });
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

test("multiple tool calls persist ordered results before the next model turn", async () => {
  const session = await Session.open(await temporarySession());
  let requests = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    if (requests === 1) return response(
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "ok", function: { name: "echo", arguments: '{"value":"42"}' } },
        { index: 1, id: "invalid", function: { name: "echo", arguments: '{}' } },
        { index: 2, id: "unknown", function: { name: "missing", arguments: '{}' } },
      ] } }] }),
      "[DONE]",
    );
    assert.deepEqual(request.messages.map((message: { role: string }) => message.role),
      ["user", "assistant", "tool", "tool", "tool"]);
    assert.deepEqual(request.messages.slice(2).map((message: { tool_call_id: string }) => message.tool_call_id),
      ["ok", "invalid", "unknown"]);
    assert.equal(request.messages[2].content, "42");
    return response('{"choices":[{"delta":{"content":"完成"}}]}', "[DONE]");
  };
  const registry = new ToolRegistry([{
    name: "echo", description: "echo", parameters: {
      type: "object", required: ["value"], properties: { value: { type: "string" } },
    },
    execute: (args) => args.value as string,
  }]);
  const events = await collectAgentEvents(session, "执行多个工具", fakeFetch, registry);
  assert.equal(requests, 2);
  assert.deepEqual(session.messages.filter((message) => message.role === "tool").map((message) => message.isError),
    [false, true, true]);
  assert.deepEqual((await Session.open(session.path)).messages, session.messages);
  assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 3);
});

test("cancellation during a tool stops the loop without storing a tool result", async () => {
  const session = await Session.open(await temporarySession());
  const controller = new AbortController();
  let requests = 0;
  const fakeFetch: typeof fetch = async () => {
    requests++;
    return response(JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: "cancel", function: { name: "cancel", arguments: "{}" },
    }] } }] }), "[DONE]");
  };
  const registry = new ToolRegistry([{
    name: "cancel", description: "cancel", parameters: { type: "object" },
    execute: () => { controller.abort(); return "ignored"; },
  }]);
  await assert.rejects(async () => {
    for await (const _event of runAgent(session, "取消", deepSeekProvider, {
      apiKey: "secret", fetch: fakeFetch, signal: controller.signal,
    }, registry)) { /* consume the run */ }
  }, { name: "AbortError" });
  assert.equal(requests, 1);
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant"]);
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

test("resumes a cancelled model response without duplicating the user message", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  const controller = new AbortController();
  const cancelledFetch: typeof fetch = async () => {
    controller.abort();
    throw new DOMException("cancelled", "AbortError");
  };
  await assert.rejects(async () => {
    for await (const _event of runAgent(session, "原问题", deepSeekProvider, {
      apiKey: "secret", fetch: cancelledFetch, signal: controller.signal,
    })) { /* consume */ }
  }, { name: "AbortError" });
  assert.equal(findPendingTurn(session.getBranch())?.targetId, session.entries[0]!.id);

  const reopened = await Session.open(path);
  let roles: string[] = [];
  const completeFetch: typeof fetch = async (_url, init) => {
    roles = JSON.parse(String(init?.body)).messages.map((message: { role: string }) => message.role);
    return response('{"choices":[{"delta":{"content":"已恢复"}}]}', "[DONE]");
  };
  for await (const _event of resumeAgent(reopened, deepSeekProvider, {
    apiKey: "secret", fetch: completeFetch,
  })) { /* consume */ }
  assert.deepEqual(roles, ["user"]);
  assert.deepEqual((await Session.open(path)).messages.map(textOf), ["原问题", "已恢复"]);
  assert.equal(findPendingTurn(reopened.getBranch()), undefined);
});

test("cancellation after a streamed text delta keeps only the complete user message", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  const controller = new AbortController();
  const fakeFetch: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半条"}}]}\n\n'));
        controller.signal.addEventListener("abort", () =>
          stream.error(new DOMException("cancelled", "AbortError")), { once: true });
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  await assert.rejects(async () => {
    for await (const event of runAgent(session, "提问", deepSeekProvider, {
      apiKey: "secret", fetch: fakeFetch, signal: controller.signal,
    })) {
      if (event.type === "message_update" && event.modelEvent.type === "text_delta") controller.abort();
    }
  }, { name: "AbortError" });
  assert.deepEqual((await Session.open(path)).messages.map(textOf), ["提问"]);
});

test("resume executes only missing tool results and then continues the model", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("两个工具"));
  await session.appendMessage({ role: "assistant", content: [
    { type: "toolCall", id: "a", name: "echo", arguments: { value: "A" } },
    { type: "toolCall", id: "b", name: "echo", arguments: { value: "B" } },
  ] });
  await session.appendMessage({ role: "tool", toolCallId: "a", content: "A", isError: false });
  let executions = 0;
  const registry = new ToolRegistry([{
    name: "echo", description: "echo", parameters: {
      type: "object", required: ["value"], properties: { value: { type: "string" } },
    },
    execute: (args) => { executions++; return args.value as string; },
  }]);
  const reopened = await Session.open(path);
  let requestIds: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requestIds = JSON.parse(String(init?.body)).messages
      .filter((message: { role: string }) => message.role === "tool")
      .map((message: { tool_call_id: string }) => message.tool_call_id);
    return response('{"choices":[{"delta":{"content":"完成"}}]}', "[DONE]");
  };
  const resumeEvents: AgentEvent[] = [];
  for await (const event of resumeAgent(reopened, deepSeekProvider, {
    apiKey: "secret", fetch: fakeFetch,
  }, registry)) resumeEvents.push(event);
  assert.equal(executions, 1);
  assert.deepEqual(requestIds, ["a", "b"]);
  const firstTurn = resumeEvents.find((event) => event.type === "turn_end");
  assert.deepEqual(firstTurn?.toolResults.map((result) => result.toolCallId), ["a", "b"]);
  assert.deepEqual((await Session.open(path)).messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"]);
});

test("discard excludes the abandoned turn and permits a fresh prompt", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("旧问题"));
  await session.appendMessage({ role: "assistant", content: [{
    type: "toolCall", id: "old", name: "echo", arguments: {},
  }] });
  const pending = findPendingTurn(session.getBranch());
  assert.ok(pending);
  await session.discard(pending.targetId);
  assert.equal(findPendingTurn(session.getBranch()), undefined);
  assert.deepEqual(buildContext(session).messages, []);
  const reopened = await Session.open(path);
  let input: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    input = JSON.parse(String(init?.body)).messages.map((message: { content: string }) => message.content);
    return response('{"choices":[{"delta":{"content":"新回答"}}]}', "[DONE]");
  };
  for await (const _event of runAgent(reopened, "新问题", deepSeekProvider, {
    apiKey: "secret", fetch: fakeFetch,
  })) { /* consume */ }
  assert.deepEqual(input, ["新问题"]);
});

test("repairs an uncommitted JSONL tail before the next append", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("已提交"));
  // 模拟 append 中途崩溃：v3 文件末尾多出半条没有换行的 JSON。
  await appendFile(path, '{"type":"broken');
  const reopened = await Session.open(path);
  await reopened.appendMessage({ role: "assistant", content: [{ type: "text", text: "后续" }] });
  assert.deepEqual((await Session.open(path)).messages.map(textOf), ["已提交", "后续"]);
  assert.equal((await readFile(path, "utf8")).split("\n").filter(Boolean).length, 3);
});

test("migrates a headerless linear session into a v3 tree", async () => {
  const path = await temporarySession();
  const user = JSON.stringify({ type: "message", timestamp: "2026-09-29T00:00:00.000Z", message: userMessage("旧问题") });
  const assistant = JSON.stringify({
    type: "message",
    timestamp: "2026-09-29T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
  });
  const discard = JSON.stringify({ type: "discard", timestamp: "2026-09-29T00:00:02.000Z", from: 0 });
  await writeFile(path, `${user}\n${assistant}\n${discard}\n`);

  const session = await Session.open(path);
  assert.equal(session.header.version, 3);
  assert.equal(session.entries.length, 3);
  const discardEntry = session.entries[2];
  if (!discardEntry || discardEntry.type !== "discard") {
    assert.fail("expected a discard entry");
  }
  assert.equal(discardEntry.targetId, session.entries[0]!.id);
  // 迁移重写文件：首行应是 header。
  const firstLine = (await readFile(path, "utf8")).split("\n")[0]!;
  assert.equal(JSON.parse(firstLine).type, "session");
  // 放弃的轮次不进入 Context。
  assert.deepEqual(buildContext(session).messages, []);
});

test("branch moves the leaf and context follows only the active branch", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("主干问题"));
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "主干回答" }] });
  const forkPoint = session.getLeafId()!;
  await session.appendMessage(userMessage("继续主干"));
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "继续回答" }] });

  session.branch(forkPoint);
  await session.appendMessage(userMessage("分支问题"));
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "分支回答" }] });

  const reopened = await Session.open(path);
  assert.deepEqual(reopened.messages.map(textOf), ["主干问题", "主干回答", "分支问题", "分支回答"]);

  reopened.branch(forkPoint);
  assert.deepEqual(reopened.messages.map(textOf), ["主干问题", "主干回答"]);

  const tree = reopened.getTree();
  assert.equal(tree.length, 1);
  const fork = tree[0]!.children[0]!;
  assert.equal(fork.children.length, 2);
  assert.deepEqual(fork.children.map((child) => child.entry.id),
    [session.entries[2]!.id, session.entries[4]!.id]);
});

test("resetLeaf starts a new root", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("第一根"));
  await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "第一回答" }] });
  session.resetLeaf();
  await session.appendMessage(userMessage("第二根"));

  assert.deepEqual(session.messages.map(textOf), ["第二根"]);
  assert.equal(session.getTree().length, 2);
});

test("branching away from a pending turn clears the pending gate", async () => {
  const path = await temporarySession();
  const session = await Session.open(path);
  await session.appendMessage(userMessage("未完成"));
  assert.ok(findPendingTurn(session.getBranch()));
  session.resetLeaf();
  assert.equal(findPendingTurn(session.getBranch()), undefined);
});

test("branch to an unknown entry id throws", async () => {
  const session = await Session.open(await temporarySession());
  assert.throws(() => session.branch("nope"), /not found/);
});
