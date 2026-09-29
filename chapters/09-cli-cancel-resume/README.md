---
order: 9
slug: cli-cancel-resume
title: CLI、取消与恢复
summary: 用交互 CLI 连续提问，取消当前运行，并从 Session 的已提交状态继续或放弃未完成轮次。
status: completed
lab: chapter-09
diffFrom: chapter-08
delta:
  concepts:
    - 待恢复轮次与显式恢复命令
    - discard 记录与模型 Context 排除
  behaviors:
    - 无参数启动交互 REPL，保留单次提问
    - Ctrl+C 取消当前请求，重启后可恢复缺失的模型或工具步骤
  files:
    - src/main.ts：交互命令与取消信号
    - src/recovery.ts：从 Session 尾部识别未完成轮次
    - src/agent.ts：继续模型和缺失工具结果
    - src/session.ts：放弃记录与崩溃尾行修复
diffFiles:
  - src/main.ts
  - src/recovery.ts
  - src/agent.ts
  - src/session.ts
  - src/context.ts
  - test/session.test.ts
---

# Chapter 9：CLI、取消与恢复

## 一句话总结

Chapter 8 的命令行每次只能回答一个问题；Ctrl+C 后虽然保留了完整消息，下次启动却不知道如何接着做。本章增加持续交互、显式续跑和放弃命令，让取消信号沿模型与工具链传播，再根据 JSONL 已提交记录决定下一步。

## 为什么需要这一章

原来的 `main.ts` 把命令行参数拼成一个 prompt，运行一次就退出。Agent 已经会在模型完成后写入 assistant、在工具执行后写入 tool result，因此一次中断可能停在三种位置：仅写入 user；写入含工具调用的 assistant；或者只写入部分 tool result。简单地再次发送原问题会重复 user，甚至重复执行已有结果的工具。

## 最小运行效果

配置 `DEEPSEEK_API_KEY` 后，从仓库根目录运行：

```bash
X_PI_SESSION_FILE=/tmp/x-pi-chapter-09.jsonl pnpm --filter @x-pi/lab-chapter-09 start
```

在 `nano-pi>` 输入问题，可以连续提问。运行中按 Ctrl+C 会显示 `Cancelled`，回到输入提示；此时输入 `/resume` 继续，或 `/discard` 放弃未完成轮次。退出并重新启动同一 Session 文件，也会提示这两个选择。`/exit` 或输入结束可退出。原有单次方式仍可用：

```bash
X_PI_SESSION_FILE=/tmp/x-pi-chapter-09.jsonl pnpm --filter @x-pi/lab-chapter-09 start -- "你好"
X_PI_SESSION_FILE=/tmp/x-pi-chapter-09.jsonl pnpm --filter @x-pi/lab-chapter-09 start -- --resume
```

若 Session 中已有未完成轮次，新的单次问题会被拒绝；先在交互模式中恢复或放弃。

## 数据流与状态

```text
stdin -> CLI -> Agent -> Model stream -> DeepSeek
          |        |           ^
          |        +-> ToolRegistry/read_file
          |                    |
Ctrl+C -> AbortController -----+  signal
          |
          v
     Session JSONL -> findPendingTurn -> /resume -> Agent 继续
          |                         |
          +-> /discard record ------+-> buildContext 排除该轮
```

Session 只持久化完整消息。取消时显示过的部分文本没有 `done`，不会写入 JSONL；恢复会重新请求这一条 assistant。工具调用 assistant 若已提交，则恢复器只执行还没有 tool result 的调用。

## 分步实现

### 1. CLI 接受多轮输入

`src/main.ts` 无参数时用 Node `readline` 建立 `nano-pi>` 循环。每个普通输入调用 `runAgent()`；`/resume` 调用 `resumeAgent()`；`/discard` 写入一条放弃记录。CLI 仍只渲染 Agent 事件，不负责提交 user、assistant 或工具结果。运行中的 Ctrl+C 触发该轮 `AbortController`；空闲时 Ctrl+C 关闭输入。单次命令取消后返回退出码 130。

### 2. 从完整记录识别待续工作

`findPendingTurn()` 按 Session 顺序扫描：遇到 user 开始一个待续轮次；普通 assistant 回答意味着完成；含 tool call 的 assistant 留下待执行调用；tool result 用 `toolCallId` 标记完成；discard 清除待续状态。返回的 `from` 是该轮起始记录索引，供放弃时定位范围。

```ts
if (message.role === "user") {
  pending = { from: index, completedCallIds: new Set(), toolResults: [] };
}
else if (message.role === "assistant" && !calls.length) pending = undefined;
else if (message.role === "tool" && pending?.assistant) {
  pending.completedCallIds.add(message.toolCallId);
  pending.toolResults.push(message);
}
```

这是对已提交日志的推导，不需要另存容易与消息顺序失配的“正在运行”布尔值。

### 3. Agent 继续缺失步骤

`resumeAgent()` 先确认存在待续轮次，再进入与新提问共用的循环。若最后只有 user，它直接构建 Context 请求模型，不再追加 user。若已有含调用的 assistant，它遍历调用并跳过 `completedCallIds`；补齐工具结果后，下一 turn 才向模型请求最终回答。

```ts
let assistant = pending?.assistant;
if (!assistant) {
  // 从已保存的 Context 请求新的 assistant。
}
for (const toolCall of calls) {
  if (pending?.completedCallIds.has(toolCall.id)) continue;
  // 执行、提交尚缺的结果。
}
```

每次恢复都重新读取 Session 文件，所以进程退出与重新启动使用同一套逻辑。工具执行后但写入结果前发生崩溃，无法证明工具已执行；本章只有只读 `read_file`，因此允许重新执行该缺失调用。

### 4. 放弃与崩溃尾行

`/discard` 追加 `{ type: "discard", timestamp, from }`。`buildContext()` 在构建模型输入时排除从该 user 到 discard 之前的消息，日志仍保留原始事实，后续问题不会带入被放弃的工具调用。Session 打开时继续忽略未换行的残片；第一次后续追加前先截掉残片，避免把新 JSON 接在坏尾行后面。以换行结束的损坏记录仍报错。

## 端到端例子

假设用户输入“读取 A 和 B”，模型生成两个 tool call：`a`、`b`。执行 `a` 后按 Ctrl+C：

| 阶段 | JSONL 中已提交的数据 | 下一步 |
| --- | --- | --- |
| 输入 | user(读取 A 和 B) | 模型请求 |
| 模型完成 | assistant(toolCall a, toolCall b) | 开始工具 |
| 中断 | tool(a 的结果) | b 尚无结果 |
| 重启并 `/resume` | 保留上述三条记录 | 只执行 b，不重写 user 或 a |
| 完成 | tool(b 的结果)、assistant(最终回答) | 等待新输入 |

若改选 `/discard`，日志会追加 discard 记录；下一次模型 Context 不包含这轮的 user、assistant 和 tool result。

## 错误与边界

- 没有待续轮次时，`/resume` 和 `--resume` 不会新建对话；交互模式会提示原因。
- 中断后必须选择恢复或放弃，避免新问题无意接在不完整的调用后面。
- 工具调用恢复按 `toolCallId` 避免重复已有结果；工具执行与 JSONL 提交之间仍存在不可消除的窗口。加入写入类工具之前需要更强的幂等或审批方案。
- 当前假设单进程写同一 Session；不处理多进程并发写、模型请求重试、完整 TUI 或跨 Session 选择。

## 运行和测试

```bash
pnpm --filter @x-pi/lab-chapter-09 test
pnpm --filter @x-pi/lab-chapter-09 typecheck
pnpm docs:build
```

离线测试模拟请求取消、跨进程重新打开 Session、部分工具结果后的续跑、放弃后的 Context 和崩溃尾行修复，不消耗 API 额度。真实交互仍需要 DeepSeek API key。

## 与 Pi 源码的关系

已核对 Pi 的 `packages/coding-agent`：CLI 提供交互模式与 session 恢复入口；AgentSession 的 `abort()` 会停止当前 Agent 并等待空闲。`packages/tui` 负责更完整的键盘事件与界面。Nano Pi 只使用 Node readline、单个固定 JSONL 文件和显式 `/resume`，把教学重点放在取消传播及已提交状态的续跑；它不是 Pi 的完整 TUI 或 SessionManager 实现。[Pi CLI 参数](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/args.ts) · [Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)

## 代码规模

本章主要新增 `recovery.ts` 约 35 行，并将 CLI 扩展至约 120 行；Agent 与 Session 的变更分别集中在续跑和日志提交边界。合计超过通常的 100–150 行参考范围，是因为交互输入、取消传播、续跑和放弃必须在同一数据流里演示，否则无法验证中断后 Context 是否正确。阅读时可依次看 CLI、恢复判定、Agent、Session。

## 已知限制与下一章

本章仍是线性 Session：无法回到历史节点建立分支，也不能选择多个会话。Chapter 10 将在此基础上学习 Session Tree、父子关系与分支导航。

## 完成验收

- [x] 有总结、运行效果、ASCII 图、关键代码解释与完整例子。
- [x] 覆盖取消、恢复、放弃、崩溃尾行及其错误边界。
- [x] 提供离线测试、独立快照和学习网站 Runtime Demo。
- [x] 更新 README、进度、源码地图与章节路线。
