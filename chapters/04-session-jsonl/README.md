---
order: 4
slug: session-jsonl
title: 用 JSONL 保存和恢复对话
summary: 把完整 user/assistant Message 追加到 Session，并在下一次启动时恢复为模型历史。
status: completed
lab: chapter-04
diffFrom: chapter-03
delta:
  concepts:
    - Session 是追加式记录，不是覆盖写入的聊天数组
    - 模型 partial 与可持久化完整消息的边界
  behaviors:
    - 每轮开始保存 user Message，done 后保存 assistant Message
    - 启动时恢复历史，忽略未提交尾行并拒绝已提交坏记录
  files:
    - src/session.ts：JSONL 追加、验证和恢复
    - src/conversation.ts：串联 Session 与模型事件流
    - src/main.ts：选择 Session 文件并运行一轮对话
diffFiles:
  - src/session.ts
  - src/conversation.ts
  - src/main.ts
---

# Chapter 4：用 JSONL 保存和恢复对话

## 一两句话总结

上一章已经用 `done` 标出了完整 assistant Message，本章把它与 user Message 逐行追加到 JSONL。程序再次启动时会恢复这些 Message，并把完整历史连同新问题一起交给模型。

## 为什么需要这一章

Chapter 3 的 `messages` 只存在于一次进程中。命令结束后数组消失，下一次提问又从空白开始；而流式响应中的 `partial` 还会不断变化，若过早保存，也可能把半条回答当成可靠历史。

JSONL 很适合这个阶段：一行就是一次已提交记录，新增消息只需追加，不必读出并重写整个文件。它也让崩溃边界可见——带换行的行已提交，没有换行的最后一段可能是一次中断写入。

## 最小运行效果

指定同一个 Session 文件连续运行两次：

```bash
X_PI_SESSION_FILE=/tmp/x-pi-demo.jsonl \
  pnpm --filter @x-pi/nano-pi start -- "记住数字 42"

# 查看第一次运行实际保存的两条记录
sed -n '1,2p' /tmp/x-pi-demo.jsonl

X_PI_SESSION_FILE=/tmp/x-pi-demo.jsonl \
  pnpm --filter @x-pi/nano-pi start -- "我让你记住了什么？"
```

第二次请求会包含第一次的 user/assistant Message。默认文件是当前目录下的 `.x-pi/session.jsonl`。

第一次运行完成后，`/tmp/x-pi-demo.jsonl` 会真实包含类似下面的内容；时间戳和模型回答会随运行变化：

```jsonl
{"type":"message","timestamp":"2026-09-19T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"记住数字 42"}]}}
{"type":"message","timestamp":"2026-09-19T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"好的，我记住了数字 42。"}]}}
```

如果不设置 `X_PI_SESSION_FILE`，可用下面的命令查看默认保存文件：

```bash
sed -n '1,20p' .x-pi/session.jsonl
```

## 数据流与提交边界

```text
Session.open(path)
      |
      +-- read complete JSONL lines --> restored Message[]
      |                                  |
new prompt                               v
      |                         append user record
      +--------------------------------->|
                                         v
                         streamModel(all messages)
                              |                 |
                         text_delta         error/abort
                              |                 |
                         terminal          no assistant record
                              |
                             done
                              |
                    append assistant record
                              |
                    next process can restore
```

user Message 在模型请求前提交，因此即使请求失败，用户说过的话仍然存在。assistant Message 只在 `done` 后提交；终端看到的半条流式文本不会成为下一次请求的历史。

## 分步实现

### 1. 定义最小 Session record

完整代码在 `apps/nano-pi/src/session.ts`：

```ts
type SessionRecord = {
  type: "message";
  timestamp: string;
  message: Message;
};
```

`type` 为未来其他记录留出判别字段，`timestamp` 记录追加时间，`message` 保留 Chapter 2 定义的应用消息。本章没有加入 header、entry id 或 parentId，因为当前只有一条线性历史；假装支持树只会制造无法验证的接口。

### 2. 恢复完整记录

`Session.open()` 读取文件并按换行切分。文件不存在或为空时得到空历史；每个完整非空行必须是合法 JSON，并通过 Message 结构检查。

```ts
const lines = text.split("\n");
if (!text.endsWith("\n")) lines.pop();
```

追加操作总是写入结尾换行，所以没有换行的最后一段不算已提交。它可能是进程在写入中间崩溃留下的半个 JSON，本章选择忽略它。位于文件中间或已经换行的损坏记录不能安全判断意图，因此直接报告行号，避免悄悄丢掉一段对话。

### 3. 先落盘，再推进内存

```ts
await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
this.messages.push(message);
```

`append()` 会先递归创建父目录，再使用追加模式写一整条记录。只有写入成功后才修改内存数组；若磁盘失败，调用者会收到异常，内存和磁盘不会在当前进程中悄悄分叉。

这不是数据库事务，也不保证多个进程同时写同一文件时的顺序。它只建立当前单进程教学应用需要的提交边界。

### 4. 用 `runTurn()` 串起 Session 与事件流

完整代码在 `apps/nano-pi/src/conversation.ts`。它先追加新 user Message，再把 `session.messages` 传给 `streamModel()`：

```ts
await session.append(user);

for await (const event of streamModel(session.messages, provider, options)) {
  if (event.type === "text_delta") onText(event.delta);
  if (event.type === "done") {
    await session.append(event.message);
    return event.message;
  }
}
```

`text_delta` 只用于即时显示。唯一能触发 assistant 持久化的是 `done`，这正是上一章引入显式生命周期事件的价值。网络截断、取消或解析失败都会在 done 之前抛错，因此不会保存 partial。

### 5. 启动时选择并打开 Session

`main.ts` 用 `X_PI_SESSION_FILE` 选择文件，未设置时使用 `.x-pi/session.jsonl`。它先 `Session.open()`，再调用 `runTurn()`；CLI 仍只负责参数、取消、输出和错误码，不直接解析 JSONL。

## 端到端完整例子

假设文件起初已有一轮“旧问题 / 旧回答”，用户输入“新问题”：

| 阶段 | 当前数据或状态 |
| --- | --- |
| 启动恢复 | `session.messages = [user("旧问题"), assistant("旧回答")]` |
| 追加输入 | JSONL 新增 user("新问题")，内存变为 3 条 |
| 模型请求 | provider 收到 `[旧问题, 旧回答, 新问题]` |
| 流式生成 | `text_delta("新")`、`text_delta("回答")` 只写终端 |
| 完整结束 | `done` 携带 assistant("新回答") |
| 提交回答 | JSONL 新增 assistant("新回答")，内存变为 4 条 |
| 检查文件 | `sed -n '1,4p' /tmp/x-pi-demo.jsonl` 可看到四条独立 JSON 记录 |
| 再次启动 | 四条完整 Message 全部恢复 |

对应 JSONL 的教学格式是：

```jsonl
{"type":"message","timestamp":"2026-09-19T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"旧问题"}]}}
{"type":"message","timestamp":"2026-09-19T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"旧回答"}]}}
{"type":"message","timestamp":"2026-09-19T10:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"新问题"}]}}
{"type":"message","timestamp":"2026-09-19T10:01:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"新回答"}]}}
```

## 错误与边界条件

- 文件不存在和零字节文件都恢复为空 Session。
- 空行被忽略，便于容忍末尾换行和人工检查时留下的空白行。
- 未以换行结束的最后一段被当成未提交写入并忽略。
- 已提交行中的畸形 JSON 或错误 Message 结构会报告准确行号。
- 目录不存在时由 `append()` 创建。
- 模型失败后保留已提交的 user Message，但不保存 partial assistant Message。
- 写入失败时不会推进内存消息数组。
- 尚未处理多进程并发写、文件锁、fsync、树形分支和格式迁移。

## 运行和测试

```bash
pnpm --filter @x-pi/nano-pi test
pnpm --filter @x-pi/lab-chapter-04 test
pnpm check
pnpm docs:build
```

新增的 5 个离线测试覆盖缺失/空文件、追加与恢复、截断尾行、已提交坏行、恢复历史进入模型请求，以及错误流不保存半条 assistant Message。整个测试过程不需要 API key，也不会消耗模型额度。

## 与 Pi 源码的关系

本章核对了 Pi 当前 Session format 与 `packages/coding-agent/src/core/session-manager.ts`：

- Pi 的第一行是 version 3 session header，后续记录按 JSONL 追加。
- message entry 保存完整 AgentMessage；终态前的 `pending` assistant 不应持久化。
- Pi entry 使用 `id` 和 `parentId` 组成树，SessionManager 维护当前 leaf，并沿活动分支构建 context。
- Pi 还支持 model/thinking change、compaction、branch summary、custom entry 和格式迁移。

Nano Pi 此处不是 Pi v3 文件格式的兼容实现。它只提取“完整消息作为追加记录、恢复后再构建请求”的最小机制；header、树和迁移会在真正需要分支的 Chapter 10 处理。当前依据见 [Pi Session File Format](https://pi.dev/docs/latest/session-format) 和 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)。

## 代码规模

- `session.ts` 96 行：记录验证、恢复和追加，其中包含函数职责、数据结构和提交边界注释。
- `conversation.ts` 31 行：一轮对话的提交顺序及状态变化说明。
- `main.ts` 因 Session 接入基本保持原规模。
- 本章新增核心教学逻辑约 127 行，当前范围足以完整表达追加、恢复和提交边界。

## 已知限制

- 只有一条线性历史，不能分支、切换 leaf 或压缩上下文。
- 一个 Session 文件没有 header 和版本号，也不兼容 Pi 的 v3 文件。
- Session 当前只含 user/assistant 文本 Message。
- 所有历史都会直接进入请求，长对话还没有 token 预算或 compaction。
- 默认固定复用一个文件，尚无会话列表、命名和恢复选择界面。

## 下一章

Chapter 5 将把“磁盘里恢复了哪些记录”和“本轮究竟向模型发送哪些消息”拆开：Session 保存事实，Context 构建负责筛选、转换并为未来的工具结果、扩展消息和 compaction 留出边界。

## 完成验收

- [x] 有一两句话总结和最小运行效果。
- [x] 有与真实实现一致、在 Markdown 源文件中直接可读的 ASCII 图。
- [x] 有关键代码解释，包含设计原因和状态变化。
- [x] 有从输入到结果的端到端完整例子。
- [x] 有错误与边界条件说明。
- [x] 有可执行的测试或验证方法。
- [x] 有与 Pi 源码的对应关系。
- [x] 有代码规模、已知限制和下一章入口。
- [x] 已更新 `README.md`、`docs/progress.md` 和 `docs/source-map.md`。
- [x] 已保存对应的 `labs/chapter-04` 快照。
