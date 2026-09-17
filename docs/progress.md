# 项目进度

这是跨会话恢复工作的唯一进度入口。开始新会话时先读本文件，再读当前章节。

```yaml
current_milestone: nano-pi
current_chapter: 01-deepseek-stream
status: ready
last_completed: 00-roadmap
next_action: 设计并实现不超过 150 行核心代码的 DeepSeek SSE 流式请求
runtime:
  node: 24.18.1
  pnpm: 11.18.0
decisions:
  - TypeScript + Node.js 24 + pnpm
  - DeepSeek 是首个 provider
  - 教学快照与持续演进应用分开保存
  - 先完成 Nano Pi 核心，再展开 Harness
```

## 已完成

- [x] 确认项目的两条路线与边界。
- [x] 建立 pnpm monorepo 骨架。
- [x] 建立根 README、章节模板和进度恢复机制。
- [x] 核对 Pi 当前顶层 packages 与核心职责。
- [x] 记录第一版 Pi 源码映射。
- [x] 完成 Chapter 0 文档。

## 下一步验收条件

Chapter 1 只有满足以下条件才算完成：

- [ ] 使用 `DEEPSEEK_API_KEY` 发起请求，不把密钥写入文件。
- [ ] 使用 Node.js 原生 `fetch`，暂不引入模型 SDK。
- [ ] 能解析 SSE 数据并实时输出文本增量。
- [ ] 能识别正常结束、HTTP 错误、协议错误和用户取消。
- [ ] 核心教学代码不超过约 150 行。
- [ ] 有离线 fixture 测试，测试不消耗 API 额度。
- [ ] 更新根 README、源码地图和本进度文件。

## 暂不处理

- Message 抽象、工具调用和 Session 持久化留到后续章节。
- Harness 的 memory 和 sandbox 要等 Agent Loop 与扩展边界稳定后再开始。
- 暂不为了“未来可能支持多个 provider”建立复杂框架。

## 恢复提示

下一位执行者应先检查工作树，然后阅读：

1. `README.md`
2. `chapters/00-roadmap/README.md`
3. `docs/source-map.md`
4. `docs/decisions.md`

