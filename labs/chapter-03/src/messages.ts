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
