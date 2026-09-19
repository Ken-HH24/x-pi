# Chapter 4 Lab

Chapter 4 的独立可运行快照：将完整消息追加到 JSONL Session，并在下一次启动时恢复历史。

```bash
pnpm --filter @x-pi/lab-chapter-04 test
X_PI_SESSION_FILE=/tmp/x-pi-demo.jsonl pnpm --filter @x-pi/lab-chapter-04 start -- "记住数字 42"
sed -n '1,20p' /tmp/x-pi-demo.jsonl
X_PI_SESSION_FILE=/tmp/x-pi-demo.jsonl pnpm --filter @x-pi/lab-chapter-04 start -- "我让你记住了什么？"
```

第一条命令成功完成后，文件中应有两行：一条 user Message 和一条完整 assistant Message。
