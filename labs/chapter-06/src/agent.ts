import { buildContext } from "./context.ts";
import {
  convertToLlm,
  userMessage,
  type AssistantMessage,
  type Message,
} from "./messages.ts";
import type { Session } from "./session.ts";
import {
  streamModel,
  type ModelEvent,
  type ModelProvider,
  type StreamOptions,
} from "./stream.ts";

type TextDeltaEvent = Extract<ModelEvent, { type: "text_delta" }>;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: AssistantMessage; modelEvent: TextDeltaEvent }
  | { type: "message_end"; message: Message }
  | { type: "turn_end"; message: AssistantMessage; toolResults: readonly Message[] }
  | { type: "agent_end"; messages: readonly Message[] };

/** 复制正在增长的模型消息，避免已发出的 Agent 事件随后被共享 partial 改写。 */
function snapshot(message: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((block) => ({ ...block })),
  };
}

/**
 * 运行最小单-turn Agent Loop，并把模型事件提升成稳定的 Agent 生命周期事件。
 * 当前没有工具，因此一次 agent run 只有一个 turn，toolResults 恒为空。
 */
export async function* runAgent(
  session: Session,
  prompt: string,
  provider: ModelProvider,
  options: StreamOptions,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const emittedMessages: Message[] = [];
  yield { type: "agent_start" };
  yield { type: "turn_start" };

  const user = userMessage(prompt);
  yield { type: "message_start", message: user };
  await session.append(user);
  emittedMessages.push(user);
  yield { type: "message_end", message: user };

  const context = buildContext(session.records);
  const llmMessages = convertToLlm(context.messages);
  for await (const modelEvent of streamModel(llmMessages, provider, options)) {
    if (modelEvent.type === "start") {
      yield { type: "message_start", message: snapshot(modelEvent.partial) };
    } else if (modelEvent.type === "text_delta") {
      yield {
        type: "message_update",
        message: snapshot(modelEvent.partial),
        modelEvent,
      };
    } else {
      await session.append(modelEvent.message);
      emittedMessages.push(modelEvent.message);
      yield { type: "message_end", message: modelEvent.message };
      yield { type: "turn_end", message: modelEvent.message, toolResults: [] };
      yield { type: "agent_end", messages: emittedMessages };
      return modelEvent.message;
    }
  }

  throw new Error("Model stream ended without a done event");
}
