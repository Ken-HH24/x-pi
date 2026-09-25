import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Tool, ToolCallContent, ToolResultMessage } from "./messages.ts";

export type RegisteredTool = Tool & {
  execute(arguments_: Record<string, unknown>): Promise<string> | string;
};

/** 校验本章使用的 JSON Schema 子集：type、properties、required 和 additionalProperties。 */
export function validateArguments(
  schema: Record<string, unknown>, value: Record<string, unknown>, path = "arguments",
): void {
  if (schema.type === "object" && (value === null || Array.isArray(value) || typeof value !== "object")) {
    throw new Error(`${path} must be an object`);
  }
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a number`);
  if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);

  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, Record<string, unknown>> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    if (!childSchema) {
      if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not allowed`);
      continue;
    }
    if (childSchema.type === "string" && typeof child !== "string") throw new Error(`${path}.${key} must be a string`);
    if (childSchema.type === "number" && (typeof child !== "number" || !Number.isFinite(child))) throw new Error(`${path}.${key} must be a number`);
    if (childSchema.type === "integer" && !Number.isInteger(child)) throw new Error(`${path}.${key} must be an integer`);
    if (childSchema.type === "boolean" && typeof child !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
    if (childSchema.type === "object") {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error(`${path}.${key} must be an object`);
      validateArguments(childSchema, child as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

/** 注册唯一工具名，并在执行时统一进行参数校验。 */
export class ToolRegistry {
  private readonly byName = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
  }

  get declarations(): Tool[] {
    return [...this.byName.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 找到工具、验证参数并执行；失败由 Agent 转成模型可见的错误结果。 */
  async execute(call: ToolCallContent): Promise<ToolResultMessage> {
    const tool = this.byName.get(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    validateArguments(tool.parameters, call.arguments);
    const content = await tool.execute(call.arguments);
    return { role: "tool", toolCallId: call.id, content, isError: false };
  }
}

/** 创建只能读取工作区内 UTF-8 文本的 read_file 工具，包含真实路径检查以阻止符号链接逃逸。 */
export function createReadFileTool(workspace = process.cwd()): RegisteredTool {
  return {
    name: "read_file",
    description: "读取工作区内的 UTF-8 文本文件",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对工作区的文件路径" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(arguments_) {
      const input = arguments_.path as string;
      if (isAbsolute(input)) throw new Error("path must be relative to the workspace");
      const root = await realpath(workspace);
      const target = resolve(root, input);
      const resolved = await realpath(target);
      const rel = relative(root, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("path escapes the workspace");
      }
      return readFile(resolved, "utf8");
    },
  };
}
