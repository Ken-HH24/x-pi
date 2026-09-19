# Chapter 6 Lab

Chapter 6 的独立可运行快照：由 Agent 层拥有一次 turn，并把模型流提升为稳定的 Agent 生命周期事件。

```bash
pnpm --filter @x-pi/lab-chapter-06 test
X_PI_SESSION_FILE=/tmp/x-pi-agent-loop.jsonl pnpm --filter @x-pi/lab-chapter-06 start -- "你好"
```

离线测试会验证完整事件顺序、逐增量消息快照，以及失败时不提交 partial assistant。
