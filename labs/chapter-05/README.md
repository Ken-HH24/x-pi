# Chapter 5 Lab

Chapter 5 的独立可运行快照：从完整 Session record 构建应用 Context，过滤只持久化不发送的记录，再转换成模型 Message。

```bash
pnpm --filter @x-pi/lab-chapter-05 test
X_PI_SESSION_FILE=/tmp/x-pi-context.jsonl pnpm --filter @x-pi/lab-chapter-05 start -- "你好"
```

离线测试中的 `note` record 会被恢复到 Session，但不会出现在模型请求中。
