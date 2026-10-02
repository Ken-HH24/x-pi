import type { Message } from "./messages.ts";
import type { Session } from "./session.ts";

export type Context = {
  messages: readonly Message[];
};

/**
 * 沿活动分支（leaf→root）构建本轮应用 Context。
 * message 进入上下文；note 保留在磁盘但不泄漏给模型；discard 排除从 targetId
 * 到该 discard 之前的消息，模拟“放弃一个未完成轮次”。
 */
export function buildContext(session: Session): Context {
  const branch = session.getBranch();
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const excluded = new Set<string>();

  for (const [discardIndex, entry] of branch.entries()) {
    if (entry.type !== "discard") continue;
    const targetIndex = indexById.get(entry.targetId);
    if (targetIndex === undefined || targetIndex >= discardIndex) continue;
    for (let i = targetIndex; i < discardIndex; i++) excluded.add(branch[i]!.id);
  }

  return {
    messages: branch.flatMap((entry) =>
      entry.type === "message" && !excluded.has(entry.id) ? [entry.message] : []
    ),
  };
}
