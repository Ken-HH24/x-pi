import type { Message } from "./messages.ts";
import type { SessionRecord } from "./session.ts";

export type Context = {
  messages: readonly Message[];
};

/**
 * 从持久化记录构建本轮应用 Context。
 * message 进入上下文，note 等 Session 事实保留在磁盘但不会泄漏给模型。
 */
export function buildContext(records: readonly SessionRecord[]): Context {
  return {
    messages: records.flatMap((record) =>
      record.type === "message" ? [record.message] : []
    ),
  };
}
