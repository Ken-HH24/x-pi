# Chapter 1 快照

这是 Chapter 1 完成时的独立代码快照，不随 `apps/nano-pi` 的后续章节修改。

```bash
pnpm --filter @x-pi/lab-chapter-01 test
pnpm --filter @x-pi/lab-chapter-01 start -- "用一句话介绍 SSE"
```

共享 `@x-pi/config` 会从当前目录向上查找最近的 `.env`，也可通过 `ENV_FILE` 指定文件。

实现讲解见 `chapters/01-deepseek-stream/README.md`。
