import "@x-pi/config/register";
import { resolve } from "node:path";
import { runTurn } from "./conversation.ts";
import { deepSeekProvider } from "./providers/deepseek.ts";
import { Session } from "./session.ts";
import { isAbortError } from "./stream.ts";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const prompt = args.join(" ").trim();
const apiKey = process.env.DEEPSEEK_API_KEY;

if (!prompt) {
  console.error('Usage: pnpm --filter @x-pi/nano-pi start -- "你的问题"');
  process.exitCode = 1;
} else if (!apiKey) {
  console.error("Missing DEEPSEEK_API_KEY");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  // 将终端 Ctrl+C 传进 fetch/ReadableStream，而不是留下悬挂连接。
  process.once("SIGINT", () => controller.abort());

  try {
    const sessionPath = resolve(process.env.X_PI_SESSION_FILE ?? ".x-pi/session.jsonl");
    const session = await Session.open(sessionPath);
    await runTurn(session, prompt, deepSeekProvider, {
      apiKey,
      model: process.env.DEEPSEEK_MODEL,
      signal: controller.signal,
    }, (delta) => process.stdout.write(delta));
    process.stdout.write("\n");
  } catch (error) {
    if (isAbortError(error)) {
      console.error("\nCancelled");
      process.exitCode = 130;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
