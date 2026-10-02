# Chapter 10 Lab

Chapter 10 的独立可运行快照：Session 由线性 JSONL 升级为带 header、id/parentId 和 leaf 指针的可导航树，并在活动分支上保留 Chapter 9 的取消与恢复语义。

```bash
pnpm --filter @x-pi/lab-chapter-10 test
pnpm --filter @x-pi/lab-chapter-10 typecheck
X_PI_SESSION_FILE=/tmp/x-pi-chapter-10.jsonl pnpm --filter @x-pi/lab-chapter-10 start
```

离线测试覆盖树形 append、branch/resetLeaf 导航、活动分支 Context、旧线性文件迁移、discard 的 targetId 语义与崩溃尾行修复。真实请求需要 `DEEPSEEK_API_KEY`。
