import "@x-pi/config/register";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { resumeAgent, runAgent, type AgentEvent } from "./agent.ts";
import { deepSeekProvider } from "./providers/deepseek.ts";
import { textOf } from "./messages.ts";
import { findPendingTurn } from "./recovery.ts";
import { Session, type SessionEntry, type SessionTreeNode } from "./session.ts";
import { isAbortError } from "./stream.ts";
import { createReadFileTool, ToolRegistry } from "./tools.ts";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const resume = args[0] === "--resume";
const prompt = resume ? "" : args.join(" ").trim();
const sessionPath = resolve(process.env.X_PI_SESSION_FILE ?? ".x-pi/session.jsonl");
const tools = new ToolRegistry([createReadFileTool()]);

/** 终端只渲染 Agent 事件，不参与消息提交或工具调度。 */
function render(event: AgentEvent): void {
  if (event.type === "message_update" && event.modelEvent.type === "text_delta") {
    process.stdout.write(event.modelEvent.delta);
  } else if (event.type === "message_update" && event.modelEvent.type === "toolcall_end") {
    process.stdout.write(`\n[tool call] ${event.modelEvent.toolCall.name} ${JSON.stringify(event.modelEvent.toolCall.arguments)}`);
  } else if (event.type === "tool_execution_end") {
    process.stdout.write(`\n[tool result] ${event.result.isError ? "error" : "ok"}: ${event.result.content.slice(0, 160)}\n`);
  }
}

/** 用一行文本概括一个 tree entry，便于 /tree 阅读。 */
function describe(entry: SessionEntry): string {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "tool") return `tool(${message.toolCallId}): ${message.content.slice(0, 40)}`;
    return `${message.role}: ${textOf(message).slice(0, 40)}`;
  }
  if (entry.type === "note") return `note: ${entry.text.slice(0, 40)}`;
  return `discard -> ${entry.targetId}`;
}

/** 递归打印 Session 树；`*` 标记当前叶子。 */
function printTree(session: Session): void {
  const render = (nodes: SessionTreeNode[], indent: string): void => {
    for (const node of nodes) {
      const marker = node.entry.id === session.getLeafId() ? "*" : " ";
      process.stdout.write(`${indent}${marker} ${node.entry.id}  ${describe(node.entry)}\n`);
      render(node.children, `${indent}    `);
    }
  };
  process.stdout.write(`session ${session.header.id} (leaf: ${session.getLeafId() ?? "空"})\n`);
  render(session.getTree(), "  ");
}

let terminal: ReturnType<typeof createInterface> | undefined;

/** 为一次运行安装取消信号，并在结束后移除监听器。 */
async function run(session: Session, input?: string, interactive = false): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  if (interactive) terminal?.on("SIGINT", onInterrupt);
  try {
    const options = { apiKey, model: process.env.DEEPSEEK_MODEL, signal: controller.signal };
    const events = input === undefined
      ? resumeAgent(session, deepSeekProvider, options, tools)
      : runAgent(session, input, deepSeekProvider, options, tools);
    for await (const event of events) render(event);
    process.stdout.write("\n");
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    if (interactive) terminal?.removeListener("SIGINT", onInterrupt);
  }
}

/** 无参数时逐轮读取输入；中断的轮次需先 /resume 或 /discard。 */
async function interactive(session: Session): Promise<void> {
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  let exiting = false;
  const onIdleInterrupt = () => { exiting = true; terminal?.close(); };
  terminal.on("SIGINT", onIdleInterrupt);
  process.stdout.write("nano-pi: 输入问题，或 /resume、/discard、/tree、/branch <id>、/reset、/leaf、/exit。\n");
  try {
    while (!exiting) {
      const pending = findPendingTurn(session.getBranch());
      if (pending) process.stdout.write("存在未完成轮次：使用 /resume 继续，或 /discard 放弃。\n");
      let input: string;
      try {
        input = (await terminal.question("nano-pi> ")).trim();
      } catch {
        break;
      }
      if (exiting) break;
      if (!input) continue;
      if (input === "/exit") break;
      if (input === "/tree") { printTree(session); continue; }
      if (input === "/leaf") {
        process.stdout.write(`当前 leaf: ${session.getLeafId() ?? "(空，下一个消息成为新根)"}\n`);
        continue;
      }
      if (input === "/reset") { session.resetLeaf(); process.stdout.write("已重置到根之前。\n"); continue; }
      if (input === "/branch") { process.stdout.write("用法：/branch <entry id>\n"); continue; }
      if (input.startsWith("/branch ")) {
        const id = input.slice("/branch ".length).trim();
        if (!id) { process.stdout.write("用法：/branch <entry id>\n"); continue; }
        try {
          session.branch(id);
          process.stdout.write(`已分支到 ${id}。\n`);
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }
      if (input === "/discard") {
        if (!pending) process.stdout.write("没有待放弃的轮次。\n");
        else { await session.discard(pending.targetId); process.stdout.write("已放弃未完成轮次。\n"); }
        continue;
      }
      if (input === "/resume" && !pending) {
        process.stdout.write("没有待恢复的轮次。\n");
        continue;
      }
      if (pending && input !== "/resume") {
        process.stdout.write("请先 /resume 或 /discard。\n");
        continue;
      }
      try {
        terminal.removeListener("SIGINT", onIdleInterrupt);
        await run(session, input === "/resume" ? undefined : input, true);
      } catch (error) {
        process.stderr.write(isAbortError(error) ? "\nCancelled\n" :
          `${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        terminal.on("SIGINT", onIdleInterrupt);
      }
    }
  } finally {
    terminal.close();
    terminal = undefined;
  }
}

try {
  const session = await Session.open(sessionPath);
  if (resume && args.length !== 1) throw new Error("Usage: --resume (without a prompt)");
  if (resume && !findPendingTurn(session.getBranch())) throw new Error("No pending turn to resume");
  if (prompt && findPendingTurn(session.getBranch())) {
    throw new Error("Pending turn: start interactive mode for /resume or /discard");
  }
  if (resume || prompt) await run(session, resume ? undefined : prompt);
  else await interactive(session);
} catch (error) {
  if (isAbortError(error)) {
    process.stderr.write("\nCancelled\n");
    process.exitCode = 130;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
