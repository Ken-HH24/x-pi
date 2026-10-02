---
order: 10
slug: session-tree
title: Session Tree 与分支
summary: 把线性 JSONL Session 升级为带 header、id/parentId 和 leaf 指针的可导航树，并在活动分支上保留取消与恢复语义。
status: completed
lab: chapter-10
diffFrom: chapter-09
delta:
  concepts:
    - Session header（version 3）与 entry 的 id/parentId
    - leaf 指针与 branch/resetLeaf 分支导航
    - discard 从数组下标改为 targetId 定位
  behaviors:
    - 打开旧线性 Session 自动迁移为 v3 树
    - /tree、/branch、/reset、/leaf 在交互模式查看和切换分支
    - Context 只沿活动分支构建，切换分支不修改历史
  files:
    - src/session.ts：header、树 entry、leaf 与旧文件迁移
    - src/context.ts：沿活动分支并按 discard targetId 排除
    - src/recovery.ts：沿活动分支识别待续轮次
    - src/main.ts：/tree、/branch、/reset、/leaf 命令
diffFiles:
  - src/session.ts
  - src/context.ts
  - src/recovery.ts
  - src/main.ts
  - test/session.test.ts
---

# Chapter 10：Session Tree 与分支

## 一句话总结

Chapter 9 的 Session 是一条线性 JSONL，无法回到历史节点另起一条对话线。本章给每条记录加上 `id`/`parentId`，用 leaf 指针表示当前位置，让 Context 沿着“叶子到根”的活动分支构建，从而支持分支、回到旧节点重问和旧文件自动迁移。

## 为什么需要这一章

Chapter 9 的 `/discard` 只能在“当前这条线”上放弃一个未完成轮次：放弃后新问题仍从同一条链继续，无法“回到模型第一次回答之前，换个问法”。树形 Session 把“追加历史”和“当前位置”拆开——历史是只增的树，leaf 只是指向某个节点的指针。切换 leaf 不会删除任何已提交记录，却能改变下一轮模型看到的 Context。

## 最小运行效果

配置 `DEEPSEEK_API_KEY` 后，从仓库根目录运行：

```bash
X_PI_SESSION_FILE=/tmp/x-pi-chapter-10.jsonl pnpm --filter @x-pi/lab-chapter-10 start
```

在 `nano-pi>` 输入问题完成一轮后，输入 `/tree` 查看树；用 `/branch <id>` 回到某个历史 entry，再输入新问题即从该处开新分支。`/leaf` 显示当前叶子，`/reset` 回到根之前。打开 Chapter 9 留下的旧 `.jsonl` 时会自动迁移为 v3 树。

## 数据流与树结构

```text
                     Session JSONL (append-only)
+------------------------------------------------------------+
| 第 1 行  {"type":"session","version":3,"id","cwd"}          |
| 其后    {"type":"message|note|discard","id","parentId",...} |
+------------------------------------------------------------+
        |  leaf 指针
        v
   [1a: user] -> [2b: assistant] -> [3c: user] -> [4d: assistant]
                        |                              ^
                        +----> [5e: user] -> [6f: assistant]   <- 当前 leaf

buildContext(session) 沿 leaf -> root 只收集 1a,2b,5e,6f；
node/discard 只作为树节点或排除标记，不进模型 Context。
```

`id` 是 8 位十六进制 entry id，`parentId` 指向父 entry（根为 `null`）。`leaf` 默认是追加顺序的最后一条；`branch()` / `resetLeaf()` 只改 leaf，不删历史。

## 分步实现

### 1. 给每条记录加 id/parentId

`src/session.ts` 把原来的 `MessageRecord | NoteRecord | DiscardRecord` 统一为带 `id`/`parentId` 的树 entry，并新增首行 header。header 是元数据，不参与树；entry id 用 `randomUUID().slice(0, 8)` 并做冲突检查，与 Pi 的 `generateId` 一致。

```ts
export const CURRENT_SESSION_VERSION = 3;

type SessionEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type MessageEntry = SessionEntryBase & { type: "message"; message: Message };
export type NoteEntry = SessionEntryBase & { type: "note"; text: string };
export type DiscardEntry = SessionEntryBase & { type: "discard"; targetId: string };
```

`discard` 的字段从 Chapter 9 的 `from: number` 换成 `targetId: string`：分支后数组下标不再稳定，只有 entry id 能精确定位被放弃的起始 user。

### 2. 追加时创建叶子子节点

`appendMessage()` / `appendNote()` / `discard()` 都经过 `appendEntry()`：生成 id、把 `parentId` 设为当前 leaf、落盘、再推进 `leafId`。第一条 append 还会先把 header 写进文件，保证新文件从第一行起就是合法 v3 会话。

```ts
private async appendEntry(entry: SessionEntry): Promise<void> {
  await mkdir(dirname(this.path), { recursive: true });
  await this.repairTail();
  if (this.headerWritten) {
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  } else {
    await appendFile(this.path, `${JSON.stringify(this.header)}\n${JSON.stringify(entry)}\n`, "utf8");
    this.headerWritten = true;
  }
  this.entries.push(entry);
  this.byId.set(entry.id, entry);
  this.leafId = entry.id;
}
```

### 3. 打开时解析并迁移旧文件

`Session.open()` 先读已提交行。首行是 `session` header 就按树格式校验每一行；否则视为 Chapter 4–9 的线性文件：补 header、按顺序生成 `id`/`parentId` 链、把 `discard.from` 下标换算成 `targetId`，最后重写文件。这对应 Pi 的 v1→v2 迁移；Nano Pi 没有 `hookMessage`，直接落到 v3。

```ts
const first = asRecord(values[0]!.value, values[0]!.line);
if (first.type === "session") {
  // v3 树：逐行 parseEntry
  return new Session(path, header, entries, true, repairBytes);
}
// 旧线性文件：迁移后重写
const legacy = values.map(({ value, line }) => parseLegacyRecord(value, line));
const { header, entries } = migrateLegacy(legacy, process.cwd());
await writeFile(path, serialize(header, entries), "utf8");
```

### 4. 沿活动分支构建 Context

`src/context.ts` 不再扫全部 records，而是拿 `session.getBranch()`（leaf→root 再反转）。message 进入 Context，note 跳过，`discard` 把 `[targetId, discard)` 区间内的 message 标记为排除——这样放弃的轮次既留在磁盘，又不泄漏给模型。

```ts
export function buildContext(session: Session): Context {
  const branch = session.getBranch();
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const excluded = new Set<string>();

  for (const [discardIndex, entry] of branch.entries()) {
    if (entry.type !== "discard") continue;
    const targetIndex = indexById.get(entry.targetId);
    if (targetIndex === undefined || targetIndex >= discardIndex) continue;
    for (let i = targetIndex; i < discardIndex; i++) excluded.add(branch[i]!.id);
  }

  return {
    messages: branch.flatMap((entry) =>
      entry.type === "message" && !excluded.has(entry.id) ? [entry.message] : []
    ),
  };
}
```

### 5. 恢复判定也只看活动分支

`src/recovery.ts` 的 `findPendingTurn()` 从“扫描全部记录”改为“扫描活动分支”。返回的 `from` 也换成 `targetId`，`/discard` 与 `buildContext` 用同一个 id 语义。分支离开一个未完成轮次后，新分支的 `findPendingTurn` 自然为空，不再阻止新问题。

```ts
if (message.role === "user") {
  pending = { targetId: entry.id, completedCallIds: new Set(), toolResults: [] };
}
```

### 6. CLI 增加树导航命令

`src/main.ts` 在交互循环里先处理 `/tree`、`/branch <id>`、`/reset`、`/leaf`，再走 Chapter 9 的 pending 门禁。`/tree` 递归打印树并用 `*` 标出当前叶子；`/branch` 只调 `session.branch(id)`，切换失败只报错、不退出。

```ts
if (input === "/tree") { printTree(session); continue; }
if (input.startsWith("/branch ")) {
  const id = input.slice("/branch ".length).trim();
  try { session.branch(id); } catch (error) { /* 打印错误 */ }
  continue;
}
if (input === "/reset") { session.resetLeaf(); continue; }
if (input === "/leaf") { /* 打印 session.getLeafId() */ continue; }
```

## 端到端例子

在 `/tmp/x-pi-chapter-10.jsonl` 中依次操作（entry id 为简化示意）：

| 阶段 | 操作 | 当前 leaf | 活动分支（Context） |
| --- | --- | --- | --- |
| 输入 | `主干问题` | 1a(user) | 1a |
| 模型完成 | （自动） | 2b(assistant) | 1a, 2b |
| 输入 | `继续主干` | 3c(user) → 4d(assistant) | 1a,2b,3c,4d |
| 导航 | `/branch 2b` | 2b | 1a, 2b |
| 输入 | `分支问题` | 5e(user) → 6f(assistant) | 1a,2b,5e,6f |
| 查看 | `/tree` | 6f | —— |

`/tree` 此时显示一个根 1a，其子 2b 有两个孩子 3c 和 5e；`*` 标在 6f。再次 `/branch 2b` 后 Context 回到 `1a,2b`，但 3c/4d/5e/6f 仍留在文件中，随时可切回。

## 错误与边界

- 首行不是 header、且某行 JSON 损坏：按行号报错；未换行的尾行视为崩溃残片，迁移或下次追加前丢弃。
- `discard(targetId)` 只接受活动分支上 role=user 的 entry，避免跨分支或对非 user 记录误标记。
- `branch(id)` 对不存在的 id 报错；`resetLeaf()` 后下一次 append 创建新的根，形成多根树。
- 迁移是**原地重写**：旧文件升级后无法再被 Chapter 9 的线性代码读取。
- 本教学版仍只有 `message`/`note`/`discard` 三类 entry，不实现 Pi 的 `branch_summary`、`compaction`、`label`、`model_change`。

## 运行和测试

```bash
pnpm --filter @x-pi/lab-chapter-10 test
pnpm --filter @x-pi/lab-chapter-10 typecheck
pnpm docs:build
```

离线测试覆盖：树形 append、`branch`/`resetLeaf` 后 Context 只沿活动分支、旧线性文件迁移、`discard` 的 targetId 语义、以及 Chapter 9 的取消/恢复/崩溃尾行在新结构下仍成立。真实交互需要 `DEEPSEEK_API_KEY`。

## 与 Pi 源码的关系

已核对 Pi 的 [`session-format.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) 与 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)：v3 header 第一行、entry 通过 `id`/`parentId` 组成树、`branch()`/`resetLeaf()` 只移动 leaf、`getBranch()` 从 leaf 走到根再反转、`buildContextEntries()` 沿活动路径选择、v1→v2 迁移补 id/parentId 并重写文件。Nano Pi 的 `generateId`（8 位 hex）、`getBranch`、`branch`/`resetLeaf` 与 Pi 同名逻辑一致；`discard` 是 Nano Pi 在 Chapter 9 引入的教学简化，Pi 靠“切走分支”天然放弃旧路径，不写 discard entry。

## 代码规模

`session.ts` 约 414 行，是本项目目前最大的单文件；`context.ts` 30 行、`recovery.ts` 33 行，`agent.ts`/`main.ts` 只做调用点替换和新增约 20 行命令。规模主要来自 header、entry 类型、id/parentId 校验、旧文件迁移和树渲染必须同时存在才能演示“分支”这一完整数据流，拆分反而会把一个概念切成无法独立运行的片段。阅读顺序建议：先看类型与 `appendEntry`，再看 `open` 的迁移分支，最后看 `getBranch`/`getTree` 与 `buildContext`。

## 已知限制与下一章

分支不会自动总结被放弃的路径，也没有 compaction；上下文只增不减，长会话仍会持续涨 token。Chapter 11 将引入 Compaction，把旧消息压缩为摘要并保留分支路径。

## 完成验收

- [x] 有总结、运行效果、ASCII 图、关键代码解释与完整例子。
- [x] 覆盖迁移、分支导航、discard 的 targetId 语义及其错误边界。
- [x] 提供离线测试、独立快照和学习网站 Runtime Demo。
- [x] 更新 README、进度、源码地图与章节路线。
