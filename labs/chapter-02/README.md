# Chapter 2 快照

这是 Chapter 2 完成时的独立代码快照，不随 `apps/nano-pi` 的后续章节修改。

```bash
pnpm --filter @x-pi/lab-chapter-02 test
pnpm --filter @x-pi/lab-chapter-02 start -- "用一句话介绍 Message"
```

共享 `@x-pi/config` 会从当前目录向上查找最近的 `.env`，也可通过 `ENV_FILE` 指定文件。离线测试会同时验证 Message 到 DeepSeek 请求的转换和流式 assistant Message 的积累。

实现讲解见 `chapters/02-message/README.md`。
