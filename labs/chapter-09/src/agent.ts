import { buildContext } from "./context.ts";
import {
  convertToLlm,
  userMessage,
  type AssistantMessage,
  type Message,
  type ToolCallContent,
  type ToolResultMessage,
} from "./messages.ts";
import type { Session } from "./session.ts";
import { findPendingTurn } from "./recovery.ts";
import { ToolRegistry } from "./tools.ts";
import {
  streamModel,
  type ModelEvent,
  type ModelProvider,
  type StreamOptions,
  isAbortError,
} from "./stream.ts";

type UpdateModelEvent = Exclude<ModelEvent, { type: "start" } | { type: "done" }>;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: AssistantMessage; modelEvent: UpdateModelEvent }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCall: ToolCallContent }
  | { type: "tool_execution_end"; toolCall: ToolCallContent; result: ToolResultMessage }
  | { type: "turn_end"; message: AssistantMessage; toolResults: readonly ToolResultMessage[] }
  | { type: "agent_end"; messages: readonly Message[] };

/** 复制正在增长的模型消息，避免已发出的 Agent 事件随后被共享 partial 改写。 */
function snapshot(message: AssistantMessage): AssistantMessage {
  return structuredClone(message);
}

/**
 * 运行最多五个模型 turn；每轮工具调用顺序执行，结果进入 Session 后再构建下一轮 Context。
 */
export async function* runAgent(
  session: Session,
  prompt: string,
  provider: ModelProvider,
  options: StreamOptions,
  registry = new ToolRegistry([]),
): AsyncGenerator<AgentEvent, AssistantMessage> {
  return yield* executeAgent(session, prompt, provider, options, registry);
}

/** 继续 Session 中最后一个未完成轮次，不再次提交 user 或已有 tool result。 */
export async function* resumeAgent(
  session: Session,
  provider: ModelProvider,
  options: StreamOptions,
  registry = new ToolRegistry([]),
): AsyncGenerator<AgentEvent, AssistantMessage> {
  if (!findPendingTurn(session.records)) throw new Error("No pending turn to resume");
  return yield* executeAgent(session, undefined, provider, options, registry);
}

/** 共享新提问与恢复的模型、工具循环；恢复时仅重放尚未提交的工作。 */
async function* executeAgent(
  session: Session,
  prompt: string | undefined,
  provider: ModelProvider,
  options: StreamOptions,
  registry: ToolRegistry,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const emittedMessages: Message[] = [];
  let pending = prompt === undefined ? findPendingTurn(session.records) : undefined;
  options.signal?.throwIfAborted();
  yield { type: "agent_start" };
  yield { type: "turn_start" };
  if (prompt !== undefined) {
    const user = userMessage(prompt);
    yield { type: "message_start", message: user };
    await session.append(user);
    emittedMessages.push(user);
    yield { type: "message_end", message: user };
  }

  for (let turn = 1; turn <= 5; turn++) {
    options.signal?.throwIfAborted();
    if (turn > 1) yield { type: "turn_start" };
    let assistant = pending?.assistant;
    if (!assistant) {
      const context = buildContext(session.records);
      const llmMessages = convertToLlm(context.messages);
      for await (const modelEvent of streamModel(llmMessages, provider, {
        ...options,
        tools: registry.declarations,
      })) {
        if (modelEvent.type === "start") {
          yield { type: "message_start", message: snapshot(modelEvent.partial) };
        } else if (modelEvent.type !== "done") {
          yield {
            type: "message_update",
            message: snapshot(modelEvent.partial),
            modelEvent: structuredClone(modelEvent),
          };
        } else {
          options.signal?.throwIfAborted();
          await session.append(modelEvent.message);
          emittedMessages.push(modelEvent.message);
          yield { type: "message_end", message: modelEvent.message };
          assistant = modelEvent.message;
        }
      }
    }
    if (!assistant) throw new Error("Model stream ended without a done event");

    const calls = assistant.content.filter((block) => block.type === "toolCall");
    const toolResults: ToolResultMessage[] = [...(pending?.toolResults ?? [])];
    for (const toolCall of calls) {
      if (pending?.completedCallIds.has(toolCall.id)) continue;
      options.signal?.throwIfAborted();
      yield { type: "tool_execution_start", toolCall };
      let result: ToolResultMessage;
      try {
        result = await registry.execute(toolCall, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (isAbortError(error) || error instanceof Error && error.name === "AbortError") throw error;
        result = {
          role: "tool",
          toolCallId: toolCall.id,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
      options.signal?.throwIfAborted();
      yield { type: "tool_execution_end", toolCall, result };
      yield { type: "message_start", message: result };
      await session.append(result);
      emittedMessages.push(result);
      toolResults.push(result);
      yield { type: "message_end", message: result };
    }
    yield { type: "turn_end", message: assistant, toolResults };
    pending = undefined;
    if (calls.length && turn === 5) throw new Error("Agent reached the five-turn tool loop limit");
    if (calls.length === 0) {
      yield { type: "agent_end", messages: emittedMessages };
      return assistant;
    }
  }

  throw new Error("Agent ended without a final assistant message");
}
