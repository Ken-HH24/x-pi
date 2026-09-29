import type { AssistantMessage, ToolCallContent, ToolResultMessage } from "./messages.ts";
import type { SessionRecord } from "./session.ts";

export type PendingTurn = {
  from: number;
  assistant?: AssistantMessage;
  completedCallIds: Set<string>;
  toolResults: ToolResultMessage[];
};

/** 从已提交记录重建待续轮次；完整普通回答或 discard 都会清除待续状态。 */
export function findPendingTurn(records: readonly SessionRecord[]): PendingTurn | undefined {
  let pending: PendingTurn | undefined;
  for (const [index, record] of records.entries()) {
    if (record.type === "discard") {
      pending = undefined;
    } else if (record.type === "message") {
      const message = record.message;
      if (message.role === "user") {
        pending = { from: index, completedCallIds: new Set(), toolResults: [] };
      } else if (message.role === "assistant") {
        const calls = message.content.filter((block): block is ToolCallContent => block.type === "toolCall");
        if (!calls.length) pending = undefined;
        else if (pending) pending = { ...pending, assistant: message, completedCallIds: new Set(), toolResults: [] };
      } else if (pending?.assistant) {
        pending.completedCallIds.add(message.toolCallId);
        pending.toolResults.push(message);
      }
    }
  }
  return pending;
}
