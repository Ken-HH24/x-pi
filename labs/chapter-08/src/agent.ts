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
import { ToolRegistry } from "./tools.ts";
import {
  streamModel,
  type ModelEvent,
  type ModelProvider,
  type StreamOptions,
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
  return {
    role: "assistant",
    content: message.content.map((block) => block.type === "text"
      ? { ...block }
      : { ...block, arguments: { ...block.arguments } }),
  };
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
  const emittedMessages: Message[] = [];
  yield { type: "agent_start" };
  yield { type: "turn_start" };
  const user = userMessage(prompt);
  yield { type: "message_start", message: user };
  await session.append(user);
  emittedMessages.push(user);
  yield { type: "message_end", message: user };

  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) yield { type: "turn_start" };
    const context = buildContext(session.records);
    const llmMessages = convertToLlm(context.messages);
    let assistant: AssistantMessage | undefined;
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
          modelEvent,
        };
      } else {
        await session.append(modelEvent.message);
        emittedMessages.push(modelEvent.message);
        yield { type: "message_end", message: modelEvent.message };
        assistant = modelEvent.message;
      }
    }
    if (!assistant) throw new Error("Model stream ended without a done event");

    const calls = assistant.content.filter((block) => block.type === "toolCall");
    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of calls) {
      if (toolCall.type !== "toolCall") continue;
      yield { type: "tool_execution_start", toolCall };
      let result: ToolResultMessage;
      try {
        result = await registry.execute(toolCall);
      } catch (error) {
        result = {
          role: "tool",
          toolCallId: toolCall.id,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
      yield { type: "tool_execution_end", toolCall, result };
      yield { type: "message_start", message: result };
      await session.append(result);
      emittedMessages.push(result);
      toolResults.push(result);
      yield { type: "message_end", message: result };
    }
    yield { type: "turn_end", message: assistant, toolResults };
    if (calls.length && turn === 5) throw new Error("Agent reached the five-turn tool loop limit");
    if (calls.length === 0) {
      yield { type: "agent_end", messages: emittedMessages };
      return assistant;
    }
  }

  throw new Error("Agent ended without a final assistant message");
}
