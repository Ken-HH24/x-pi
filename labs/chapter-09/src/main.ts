import "@x-pi/config/register";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { resumeAgent, runAgent, type AgentEvent } from "./agent.ts";
import { deepSeekProvider } from "./providers/deepseek.ts";
import { findPendingTurn } from "./recovery.ts";
import { Session } from "./session.ts";
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
  process.stdout.write("nano-pi: 输入问题，或 /resume、/discard、/exit。\n");
  try {
    while (!exiting) {
      const pending = findPendingTurn(session.records);
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
      if (input === "/discard") {
        if (!pending) process.stdout.write("没有待放弃的轮次。\n");
        else { await session.discard(pending.from); process.stdout.write("已放弃未完成轮次。\n"); }
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
  if (resume && !findPendingTurn(session.records)) throw new Error("No pending turn to resume");
  if (prompt && findPendingTurn(session.records)) {
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
