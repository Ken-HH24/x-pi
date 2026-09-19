# 项目进度

这是跨会话恢复工作的唯一进度入口。开始新会话时先读本文件，再读当前章节。

```yaml
current_milestone: nano-pi
current_chapter: 04-session-jsonl
status: ready
last_completed: 03-model-events
next_action: 将 done 事件产生的完整 Message 追加到 JSONL Session，并实现恢复
runtime:
  node: 24.18.1
  pnpm: 11.18.0
decisions:
  - TypeScript + Node.js 24 + pnpm
  - DeepSeek 是首个 provider
  - 教学快照与持续演进应用分开保存
  - 先完成 Nano Pi 核心，再展开 Harness
  - 每章包含关键代码解释、端到端例子和 Markdown 可见的 ASCII 图
```

## 已完成

- [x] 确认项目的两条路线与边界。
- [x] 建立 pnpm monorepo 骨架。
- [x] 建立根 README、章节模板和进度恢复机制。
- [x] 核对 Pi 当前顶层 packages 与核心职责。
- [x] 记录第一版 Pi 源码映射。
- [x] 完成 Chapter 0 文档。
- [x] 使用 Node.js 原生 fetch 发起 DeepSeek 流式请求。
- [x] 实现跨网络分片的 SSE 解析和 `[DONE]` 完整性检查。
- [x] 实现 HTTP、协议、截断和取消错误处理。
- [x] 将通用 HTTP/SSE 与 DeepSeek provider 分离并通过参数注入。
- [x] 添加 5 个不消耗 API 额度的离线测试。
- [x] 保存 Chapter 1 独立代码快照。
- [x] 完成包含流程图、逐段代码解释和完整演算的 Chapter 1 教程。
- [x] 定义最小 user/assistant Message 和文本 content block。
- [x] 在 DeepSeek provider 边界将应用 Message 转成模型请求。
- [x] 保留流式输出，并把文本增量积累成完整 assistant Message。
- [x] 添加 Chapter 2 端到端离线测试与独立代码快照。
- [x] 完成 Chapter 2 的数据流图、关键代码解释和完整演算。
- [x] 建立定制章节学习网站、章节搜索与关键 lab Diff。
- [x] 配置真实 TypeScript typecheck 和 Node.js 类型。
- [x] 核对 Pi 当前 Provider、Model、API 与 AssistantMessageEvent 边界。
- [x] 用 start、text_delta 和 done 取代裸字符串增量。
- [x] 用共享 partial 构建 assistant Message，并让终端只消费统一事件。
- [x] 添加 Chapter 3 离线测试、独立快照与完整教程。

## 下一步验收条件

Chapter 4 只有满足以下条件才算完成：

- [ ] 核对 Pi 当前 Session JSONL 格式与追加/恢复边界。
- [ ] 定义最小 Session 记录，不提前引入树形分支。
- [ ] 在 user Message 和 done assistant Message 产生时追加 JSONL。
- [ ] 启动时恢复历史，并将其发送给模型。
- [ ] 处理空文件、损坏行和未完成最后一行。
- [ ] 添加离线测试、完整讲解和 Chapter 4 快照。

## 暂不处理

- 工具调用和 Session 持久化留到后续章节。
- Harness 的 memory 和 sandbox 要等 Agent Loop 与扩展边界稳定后再开始。
- 暂不为了“未来可能支持多个 provider”建立复杂框架。

## 恢复提示

下一位执行者应先检查工作树，然后阅读：

1. `README.md`
2. `chapters/03-model-events/README.md`
3. `docs/source-map.md`
4. `docs/decisions.md`
5. `docs/chapter-template.md`
