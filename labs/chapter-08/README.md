# Chapter 8 Lab

Chapter 8 的独立可运行快照：注册并验证工具，执行调用，把结果写入 Session，并继续模型 turn。

```bash
pnpm --filter @x-pi/lab-chapter-08 test
pnpm --filter @x-pi/lab-chapter-08 typecheck
X_PI_SESSION_FILE=/tmp/x-pi-chapter-08.jsonl pnpm --filter @x-pi/lab-chapter-08 start -- "读取 README.md 并概括项目"
```

离线测试验证多轮请求、工具错误回传、五轮上限、schema 参数与工作区路径约束。真实请求需要 `DEEPSEEK_API_KEY`。
