export type TextContent = { type: "text"; text: string };

export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type UserMessage = {
  role: "user";
  content: readonly TextContent[];
};

export type AssistantMessage = {
  role: "assistant";
  content: readonly (TextContent | ToolCallContent)[];
};

export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  content: string;
  isError: boolean;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 模型层只接收已经规范化的角色与文本，不理解应用侧 content block。 */
export type LlmMessage =
  | { role: "user"; content: string }
  | {
    role: "assistant";
    content: string | null;
    toolCalls?: readonly ToolCallContent[];
  }
  | { role: "tool"; toolCallId: string; content: string };

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function textOf(message: Message): string {
  if (message.role === "tool") return message.content;
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

/** 将应用 Message 转成模型层 Message；厂商 JSON 仍由 provider 负责。 */
export function convertToLlm(messages: readonly Message[]): LlmMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", content: textOf(message) };
    if (message.role === "tool") {
      return { role: "tool", toolCallId: message.toolCallId, content: message.content };
    }
    const toolCalls = message.content.filter((block) => block.type === "toolCall");
    const text = textOf(message);
    return {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  });
}
