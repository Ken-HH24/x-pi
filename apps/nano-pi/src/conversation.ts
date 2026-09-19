import { userMessage, type AssistantMessage } from "./messages.ts";
import type { Session } from "./session.ts";
import {
  streamModel,
  type ModelProvider,
  type StreamOptions,
} from "./stream.ts";

/**
 * 运行一轮持久化对话：先提交 user，再发送完整历史，最后只提交 done 消息。
 * 状态变化：[历史] -> [历史, user] -> [历史, user, assistant]；失败时停在第二步。
 */
export async function runTurn(
  session: Session,
  prompt: string,
  provider: ModelProvider,
  options: StreamOptions,
  onText: (delta: string) => void = () => {},
): Promise<AssistantMessage> {
  const user = userMessage(prompt);
  await session.append(user);

  for await (const event of streamModel(session.messages, provider, options)) {
    if (event.type === "text_delta") onText(event.delta);
    if (event.type === "done") {
      await session.append(event.message);
      return event.message;
    }
  }
  throw new Error("Model stream ended without a done event");
}
