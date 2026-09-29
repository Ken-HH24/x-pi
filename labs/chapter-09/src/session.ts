import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "./messages.ts";

export type MessageRecord = {
  type: "message";
  timestamp: string;
  message: Message;
};

export type NoteRecord = {
  type: "note";
  timestamp: string;
  text: string;
};

export type DiscardRecord = {
  type: "discard";
  timestamp: string;
  from: number;
};

export type SessionRecord = MessageRecord | NoteRecord | DiscardRecord;

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

/**
 * 将一行 JSONL 转成已验证的 SessionRecord，并在错误中保留行号。
 * 示例：{"type":"message","timestamp":"...","message":{"role":"user","content":[...]}}
 */
function parseRecord(line: string, lineNumber: number): SessionRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid session JSONL at line ${lineNumber}`);
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Invalid session record at line ${lineNumber}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.timestamp !== "string") {
    throw new Error(`Invalid session record at line ${lineNumber}`);
  }
  if (record.type === "message" && isMessage(record.message)) {
    return record as MessageRecord;
  }
  if (record.type === "note" && typeof record.text === "string") {
    return record as NoteRecord;
  }
  if (record.type === "discard" && Number.isInteger(record.from) &&
    (record.from as number) >= 0 && (record.from as number) < lineNumber - 1) {
    return record as DiscardRecord;
  }
  throw new Error(`Invalid session record at line ${lineNumber}`);
}

export class Session {
  readonly path: string;
  readonly records: SessionRecord[];
  private repairBytes: number | undefined;

  private constructor(path: string, records: SessionRecord[], repairBytes?: number) {
    this.path = path;
    this.records = records;
    this.repairBytes = repairBytes;
  }

  /** 兼容只关心对话的调用方；Context 构建应直接读取 records。 */
  get messages(): Message[] {
    return this.records.flatMap((record) =>
      record.type === "message" ? [record.message] : []
    );
  }

  /**
   * 打开并恢复 Session；只读取以换行结束的已提交记录。
   * 不存在或空文件得到 []，未换行的尾部残片会被忽略。
   */
  static async open(path: string): Promise<Session> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Session(path, []);
      throw error;
    }

    const lines = text.split("\n");
    // append 中断时最后一条可能只有半个 JSON；没有换行就不把它当成已提交记录。
    const committed = text.lastIndexOf("\n") + 1;
    if (!text.endsWith("\n")) lines.pop();
    const records: SessionRecord[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const record = parseRecord(line, index + 1);
      const start = record.type === "discard" ? records[record.from] : undefined;
      if (record.type === "discard" &&
        (start?.type !== "message" || start.message.role !== "user")) {
        throw new Error(`Invalid discard start at line ${index + 1}`);
      }
      records.push(record);
    }
    return new Session(path, records,
      committed < text.length ? Buffer.byteLength(text.slice(0, committed)) : undefined);
  }

  /** 第一次追加前移除未提交的尾行，防止新 JSON 拼接到残片后面。 */
  private async repairTail(): Promise<void> {
    if (this.repairBytes === undefined) return;
    await truncate(this.path, this.repairBytes);
    this.repairBytes = undefined;
  }

  /** 追加一条记录，磁盘成功后才推进内存状态。 */
  private async appendRecord(record: SessionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await this.repairTail();
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.records.push(record);
  }

  /**
   * 将一条完整 Message 追加为单行 JSONL，成功落盘后再推进内存历史。
   * 磁盘与内存顺序均为：[旧消息..., message]。
   */
  async append(message: Message): Promise<void> {
    const record: SessionRecord = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
    };
    await this.appendRecord(record);
  }

  /** 保存不会进入模型 Context 的会话备注，示范存储与推理上下文的边界。 */
  async appendNote(text: string): Promise<void> {
    const record: NoteRecord = {
      type: "note",
      timestamp: new Date().toISOString(),
      text,
    };
    await this.appendRecord(record);
  }

  /** 标记从 user 记录开始的未完成轮次已放弃，供 Context 排除。 */
  async discard(from: number): Promise<void> {
    const start = this.records[from];
    if (!Number.isInteger(from) || start?.type !== "message" || start.message.role !== "user") {
      throw new Error("Invalid discard start");
    }
    await this.appendRecord({ type: "discard", timestamp: new Date().toISOString(), from });
  }
}
