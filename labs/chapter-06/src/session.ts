import { appendFile, mkdir, readFile } from "node:fs/promises";
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

export type SessionRecord = MessageRecord | NoteRecord;

/** 判断未知值是否是当前教学版支持的 user/assistant 文本 Message。 */
function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.role !== "user" && candidate.role !== "assistant") return false;
  if (!Array.isArray(candidate.content)) return false;
  return candidate.content.every((block) => {
    if (!block || typeof block !== "object") return false;
    const content = block as Record<string, unknown>;
    return content.type === "text" && typeof content.text === "string";
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
  throw new Error(`Invalid session record at line ${lineNumber}`);
}

export class Session {
  readonly path: string;
  readonly records: SessionRecord[];

  private constructor(path: string, records: SessionRecord[]) {
    this.path = path;
    this.records = records;
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
    if (!text.endsWith("\n")) lines.pop();
    const records = lines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.trim() !== "")
      .map(({ line, lineNumber }) => parseRecord(line, lineNumber));
    return new Session(path, records);
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
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    // 只有磁盘追加成功后才推进内存，避免两份状态悄悄分叉。
    this.records.push(record);
  }

  /** 保存不会进入模型 Context 的会话备注，示范存储与推理上下文的边界。 */
  async appendNote(text: string): Promise<void> {
    const record: NoteRecord = {
      type: "note",
      timestamp: new Date().toISOString(),
      text,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.records.push(record);
  }
}
