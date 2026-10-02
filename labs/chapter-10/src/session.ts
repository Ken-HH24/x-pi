import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Message } from "./messages.ts";

/** 与 Pi 的 CURRENT_SESSION_VERSION 对齐；Nano Pi 只产生 v3 文件。 */
export const CURRENT_SESSION_VERSION = 3;

/** 首行 header 是元数据，不参与树（没有 id/parentId）。 */
export type SessionHeader = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
};

type SessionEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type MessageEntry = SessionEntryBase & {
  type: "message";
  message: Message;
};

export type NoteEntry = SessionEntryBase & {
  type: "note";
  text: string;
};

export type DiscardEntry = SessionEntryBase & {
  type: "discard";
  targetId: string;
};

export type SessionEntry = MessageEntry | NoteEntry | DiscardEntry;

/** getTree() 返回的防御性结构；children 按追加顺序排列。 */
export type SessionTreeNode = {
  entry: SessionEntry;
  children: SessionTreeNode[];
};

/** 判断未知值是否是当前教学版支持的文本或工具调用内容块。 */
function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.role === "tool") {
    return typeof candidate.toolCallId === "string" && typeof candidate.content === "string" &&
      typeof candidate.isError === "boolean";
  }
  if (candidate.role !== "user" && candidate.role !== "assistant") return false;
  if (!Array.isArray(candidate.content)) return false;
  return candidate.content.every((block) => {
    if (!block || typeof block !== "object") return false;
    const content = block as Record<string, unknown>;
    if (content.type === "text") return typeof content.text === "string";
    return candidate.role === "assistant" && content.type === "toolCall" &&
      typeof content.id === "string" && typeof content.name === "string" &&
      Boolean(content.arguments) && typeof content.arguments === "object" &&
      !Array.isArray(content.arguments);
  });
}

/** 把未知值收窄为对象，保留行号用于报错。 */
function asRecord(value: unknown, line: number): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`Invalid session record at line ${line}`);
  return value as Record<string, unknown>;
}

/** 生成 8 位十六进制 entry id，并检查与已用 id 冲突。 */
function generateId(used: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!used.has(id)) return id;
  }
  return randomUUID();
}

function createHeader(cwd: string): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
}

/** 校验首行 header；cwd 对旧文件宽松处理为空字符串。 */
function parseHeader(value: unknown, line: number): SessionHeader {
  const record = asRecord(value, line);
  if (record.type !== "session") throw new Error(`Invalid session header at line ${line}`);
  if (typeof record.id !== "string" || typeof record.timestamp !== "string") {
    throw new Error(`Invalid session header at line ${line}`);
  }
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid session header version at line ${line}`);
  }
  return {
    type: "session",
    version,
    id: record.id,
    timestamp: record.timestamp,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
  };
}

/** 校验树格式 entry（header 之后的每一行都带 id/parentId）。 */
function parseEntry(value: unknown, line: number): SessionEntry {
  const record = asRecord(value, line);
  const id = record.id;
  const parentId = record.parentId;
  const timestamp = record.timestamp;
  if (typeof id !== "string") throw new Error(`Invalid session record at line ${line}`);
  if (parentId !== null && typeof parentId !== "string") throw new Error(`Invalid session record at line ${line}`);
  if (typeof timestamp !== "string") throw new Error(`Invalid session record at line ${line}`);
  const base: SessionEntryBase = { id, parentId, timestamp };
  if (record.type === "message" && isMessage(record.message)) {
    return { ...base, type: "message", message: record.message };
  }
  if (record.type === "note" && typeof record.text === "string") {
    return { ...base, type: "note", text: record.text };
  }
  if (record.type === "discard" && typeof record.targetId === "string") {
    return { ...base, type: "discard", targetId: record.targetId };
  }
  throw new Error(`Invalid session record at line ${line}`);
}

/** Chapter 4–9 的线性记录：没有 header，也没有 id/parentId。 */
type LegacyRecord =
  | { type: "message"; timestamp: string; message: Message }
  | { type: "note"; timestamp: string; text: string }
  | { type: "discard"; timestamp: string; from: number };

function parseLegacyRecord(value: unknown, line: number): LegacyRecord {
  const record = asRecord(value, line);
  if (typeof record.timestamp !== "string") throw new Error(`Invalid session record at line ${line}`);
  if (record.type === "message" && isMessage(record.message)) {
    return { type: "message", timestamp: record.timestamp, message: record.message };
  }
  if (record.type === "note" && typeof record.text === "string") {
    return { type: "note", timestamp: record.timestamp, text: record.text };
  }
  if (record.type === "discard" && Number.isInteger(record.from) && (record.from as number) >= 0) {
    return { type: "discard", timestamp: record.timestamp, from: record.from as number };
  }
  throw new Error(`Invalid session record at line ${line}`);
}

/**
 * 把线性旧文件升级为树：补 header，按顺序生成 id/parentId 链，
 * 并把 discard.from（下标）换算成指向起始 user entry 的 targetId。
 * 对应 Pi 的 v1→v2 迁移；Nano Pi 没有 hookMessage，因此直接落到 v3。
 */
function migrateLegacy(
  records: readonly LegacyRecord[],
  cwd: string,
): { header: SessionHeader; entries: SessionEntry[] } {
  const used = new Set<string>();
  const idByIndex = new Map<number, string>();
  const entries: SessionEntry[] = [];
  let prevId: string | null = null;

  for (const [index, record] of records.entries()) {
    const id = generateId(used);
    used.add(id);
    idByIndex.set(index, id);
    const base: SessionEntryBase = { id, parentId: prevId, timestamp: record.timestamp };
    if (record.type === "message") {
      entries.push({ ...base, type: "message", message: record.message });
    } else if (record.type === "note") {
      entries.push({ ...base, type: "note", text: record.text });
    } else {
      // discard 的 targetId 要等全部 id 分配完成后才能换算，先占位。
      entries.push({ ...base, type: "discard", targetId: "" });
    }
    prevId = id;
  }

  for (const [index, record] of records.entries()) {
    if (record.type !== "discard") continue;
    const targetId = idByIndex.get(record.from);
    const target = records[record.from];
    if (!targetId || target?.type !== "message" || target.message.role !== "user") {
      throw new Error(`Invalid discard start at line ${index + 1}`);
    }
    entries[index] = { ...entries[index], type: "discard", targetId } as SessionEntry;
  }

  return { header: createHeader(cwd), entries };
}

function serialize(header: SessionHeader, entries: readonly SessionEntry[]): string {
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
  return `${lines.join("\n")}\n`;
}

export class Session {
  readonly path: string;
  readonly header: SessionHeader;
  readonly entries: SessionEntry[];
  private readonly byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private headerWritten: boolean;
  private repairBytes: number | undefined;

  private constructor(
    path: string,
    header: SessionHeader,
    entries: SessionEntry[],
    headerWritten: boolean,
    repairBytes?: number,
  ) {
    this.path = path;
    this.header = header;
    this.entries = entries;
    this.headerWritten = headerWritten;
    this.repairBytes = repairBytes;
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.byId.clear();
    this.leafId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      // 叶子默认是追加顺序里的最后一条；branch/resetLeaf 会显式改它。
      this.leafId = entry.id;
    }
  }

  /** 活动分支上的消息（不含 discard 排除）；模型输入应使用 buildContext()。 */
  get messages(): Message[] {
    return this.getBranch().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : []
    );
  }

  /**
   * 打开并恢复 Session；只读取以换行结束的已提交记录。
   * 首行不是 header 时按 Chapter 4–9 线性文件迁移并重写为 v3 树。
   */
  static async open(path: string): Promise<Session> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Session(path, createHeader(process.cwd()), [], false);
      }
      throw error;
    }

    const lines = text.split("\n");
    const committed = text.lastIndexOf("\n") + 1;
    if (!text.endsWith("\n")) lines.pop();
    const repairBytes = committed < text.length ? Buffer.byteLength(text.slice(0, committed)) : undefined;

    const values: Array<{ value: unknown; line: number }> = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid session JSONL at line ${index + 1}`);
      }
      values.push({ value, line: index + 1 });
    }

    if (values.length === 0) {
      return new Session(path, createHeader(process.cwd()), [], false);
    }

    const firstValue = values[0]!;
    const first = asRecord(firstValue.value, firstValue.line);
    if (first.type === "session") {
      const header = parseHeader(first, firstValue.line);
      const entries = values.slice(1).map(({ value, line }) => parseEntry(value, line));
      if (header.version !== CURRENT_SESSION_VERSION) {
        const upgraded: SessionHeader = { ...header, version: CURRENT_SESSION_VERSION };
        await writeFile(path, serialize(upgraded, entries), "utf8");
        return new Session(path, upgraded, entries, true);
      }
      return new Session(path, header, entries, true, repairBytes);
    }

    const legacy = values.map(({ value, line }) => parseLegacyRecord(value, line));
    const { header, entries } = migrateLegacy(legacy, process.cwd());
    await writeFile(path, serialize(header, entries), "utf8");
    return new Session(path, header, entries, true);
  }

  /** 第一次追加前移除未提交的尾行，防止新 JSON 拼接到残片后面。 */
  private async repairTail(): Promise<void> {
    if (this.repairBytes === undefined) return;
    await truncate(this.path, this.repairBytes);
    this.repairBytes = undefined;
  }

  /** 追加一条 entry：首条同时写入 header；磁盘成功后才推进内存与叶子。 */
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

  /** 在当前叶子下追加一条 message，并推进叶子。返回 entry id。 */
  async appendMessage(message: Message): Promise<string> {
    const entry: MessageEntry = {
      type: "message",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    await this.appendEntry(entry);
    return entry.id;
  }

  /** 追加一条不进入模型 Context 的 note，同样作为树节点。 */
  async appendNote(text: string): Promise<string> {
    const entry: NoteEntry = {
      type: "note",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      text,
    };
    await this.appendEntry(entry);
    return entry.id;
  }

  /** 标记活动分支上以 targetId 开始的未完成轮次已放弃，供 Context 排除。 */
  async discard(targetId: string): Promise<void> {
    const target = this.byId.get(targetId);
    if (!target || target.type !== "message" || target.message.role !== "user") {
      throw new Error("Invalid discard target");
    }
    if (!this.getBranch().some((entry) => entry.id === targetId)) {
      throw new Error("Discard target is not on the active branch");
    }
    const entry: DiscardEntry = {
      type: "discard",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
    };
    await this.appendEntry(entry);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  /** 从指定 entry（默认叶子）走到根再反转，得到 root→leaf 的活动分支。 */
  getBranch(fromId: string | null = this.leafId): SessionEntry[] {
    const path: SessionEntry[] = [];
    let current = fromId ? this.byId.get(fromId) : undefined;
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  /** 把 entry 组装成树；孤立 entry（父链断裂）也作为根返回。 */
  getTree(): SessionTreeNode[] {
    const nodes = new Map<string, SessionTreeNode>();
    for (const entry of this.entries) nodes.set(entry.id, { entry, children: [] });
    const roots: SessionTreeNode[] = [];
    for (const entry of this.entries) {
      const node = nodes.get(entry.id)!;
      const parent = entry.parentId !== null ? nodes.get(entry.parentId) : undefined;
      if (entry.parentId === null || entry.parentId === entry.id || !parent) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    return roots;
  }

  /** 把叶子指针移到历史 entry；下一次 append 会从该处创建新分支，不修改已有历史。 */
  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
    this.leafId = branchFromId;
  }

  /** 把叶子重置到根之前；下一次 append 会创建新的根 entry。 */
  resetLeaf(): void {
    this.leafId = null;
  }
}
