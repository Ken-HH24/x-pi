export const roadmapGroups = [
  { id: "protocol", title: "模型与协议", color: "blue", range: [0, 1, 2, 3] },
  { id: "context", title: "会话与上下文", color: "emerald", range: [4, 5] },
  { id: "agent", title: "Agent 与工具", color: "purple", range: [6, 7, 8] },
  { id: "interface", title: "交互与演进", color: "amber", range: [9, 10, 11, 12] },
  { id: "review", title: "全链路复盘", color: "red", range: [13] },
] as const;

export const roadmap = [
  { title: "阅读地图与最小工程", shortTitle: "Roadmap", group: "protocol" },
  { title: "DeepSeek 流式请求", shortTitle: "SSE Stream", group: "protocol" },
  { title: "Message 与内容块", shortTitle: "Message", group: "protocol" },
  { title: "统一模型事件流与 Provider 演进", shortTitle: "Model Events", group: "protocol" },
  { title: "Session 与 JSONL", shortTitle: "Session", group: "context" },
  { title: "Context 构建与模型转换", shortTitle: "Context", group: "context" },
  { title: "最小 Agent Loop", shortTitle: "Agent Loop", group: "agent" },
  { title: "Tool Calling 协议", shortTitle: "Tool Calling", group: "agent" },
  { title: "多轮工具循环", shortTitle: "Tool Loop", group: "agent" },
  { title: "CLI、取消与恢复", shortTitle: "CLI & Resume", group: "interface" },
  { title: "Session Tree 与分支", shortTitle: "Session Tree", group: "interface" },
  { title: "Compaction", shortTitle: "Compaction", group: "interface" },
  { title: "Extension 与生命周期事件", shortTitle: "Extensions", group: "interface" },
  { title: "对照 Pi 源码复盘", shortTitle: "Source Review", group: "review" },
] as const;

export function groupForChapter(order: number) {
  return roadmapGroups.find((group) => group.range.some((item) => item === order)) ?? roadmapGroups[0];
}
