# Chapter 9 Lab

Chapter 9 的独立可运行快照：交互提问、取消当前轮次，并从 JSONL 已提交状态显式恢复或放弃。

```bash
pnpm --filter @x-pi/lab-chapter-09 test
pnpm --filter @x-pi/lab-chapter-09 typecheck
X_PI_SESSION_FILE=/tmp/x-pi-chapter-09.jsonl pnpm --filter @x-pi/lab-chapter-09 start
```

在提示符中输入问题、`/resume`、`/discard` 或 `/exit`；原有单次提问方式仍可用。离线测试验证取消、重启恢复、工具结果去重、放弃及崩溃尾行修复。真实模型请求需要 `DEEPSEEK_API_KEY`。
