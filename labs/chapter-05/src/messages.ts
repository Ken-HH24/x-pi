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

/** 模型层只接收已经规范化的角色与文本，不理解应用侧 content block。 */
export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function textOf(message: Message): string {
  return message.content.map((block) => block.text).join("");
}

/** 将应用 Message 转成模型层 Message；厂商 JSON 仍由 provider 负责。 */
export function convertToLlm(messages: readonly Message[]): LlmMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: textOf(message),
  }));
}
