# 项目进度

这是跨会话恢复工作的唯一进度入口。开始新会话时先读本文件，再读当前章节。

```yaml
current_milestone: nano-pi
current_chapter: 02-message
status: ready
last_completed: 01-deepseek-stream
next_action: 从真实 DeepSeek 请求和响应中提取最小 Message 与 content block
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

## 下一步验收条件

Chapter 2 只有满足以下条件才算完成：

- [ ] 用一两个具体对象解释字符串为什么不足以保存对话。
- [ ] 提供 Message 从用户输入到模型请求再到 assistant Message 的端到端演算。
- [ ] 提供 Message 转换和流式积累的 ASCII 数据流图。
- [ ] 逐段解释新增关键代码及其设计原因。
- [ ] 定义最小的 user/assistant Message 和文本 content block。
- [ ] 将请求构造从裸 prompt 改为 Message 转换。
- [ ] 将流式文本积累成可保存的 assistant Message。
- [ ] 保持 Chapter 1 的流式体验和错误处理。
- [ ] 核心新增教学代码不超过约 150 行。
- [ ] 添加离线测试并保存 Chapter 2 快照。

## 暂不处理

- 工具调用和 Session 持久化留到后续章节。
- Harness 的 memory 和 sandbox 要等 Agent Loop 与扩展边界稳定后再开始。
- 暂不为了“未来可能支持多个 provider”建立复杂框架。

## 恢复提示

下一位执行者应先检查工作树，然后阅读：

1. `README.md`
2. `chapters/01-deepseek-stream/README.md`
3. `docs/source-map.md`
4. `docs/decisions.md`
5. `docs/chapter-template.md`
