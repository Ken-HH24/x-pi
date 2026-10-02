import type { AssistantMessage, ToolCallContent, ToolResultMessage } from "./messages.ts";
import type { SessionEntry } from "./session.ts";

export type PendingTurn = {
  /** 起始 user entry 的 id，供 /discard 按 id 定位，而不是依赖易变的数组下标。 */
  targetId: string;
  assistant?: AssistantMessage;
  completedCallIds: Set<string>;
  toolResults: ToolResultMessage[];
};

/** 沿活动分支（root→leaf）重建待续轮次；完整普通回答或 discard 都会清除待续状态。 */
export function findPendingTurn(branch: readonly SessionEntry[]): PendingTurn | undefined {
  let pending: PendingTurn | undefined;
  for (const entry of branch) {
    if (entry.type === "discard") {
      pending = undefined;
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        pending = { targetId: entry.id, completedCallIds: new Set(), toolResults: [] };
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
