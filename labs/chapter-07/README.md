# Chapter 7 Lab

Chapter 7 的独立可运行快照：声明工具，组装跨 SSE chunk 的参数，并把结构化 tool call 提升为模型与 Agent 事件。

```bash
pnpm --filter @x-pi/lab-chapter-07 test
X_PI_SESSION_FILE=/tmp/x-pi-tool-call.jsonl pnpm --filter @x-pi/lab-chapter-07 start -- "读取 README.md"
```

离线测试会验证工具声明的请求转换、参数跨 chunk 组装、事件顺序、JSON 校验与 Session 恢复；本章不会执行工具。
