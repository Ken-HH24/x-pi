export type TextContent = { type: "text"; text: string };

export type UserMessage = {
  role: "user";
  content: readonly TextContent[];
};

export type AssistantMessage = {
  role: "assistant";
  content: readonly TextContent[];
};

export type Message = UserMessage | AssistantMessage;

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function textOf(message: Message): string {
  return message.content.map((block) => block.text).join("");
}

export async function collectAssistantMessage(
  stream: AsyncIterable<string>,
  onText: (text: string) => void = () => {},
): Promise<AssistantMessage> {
  const block: TextContent = { type: "text", text: "" };
  const message: AssistantMessage = { role: "assistant", content: [block] };

  for await (const text of stream) {
    // 先增量展示，再把同一增量写进最终可保存的消息。
    onText(text);
    block.text += text;
  }
  return message;
}
