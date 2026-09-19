import "@x-pi/config/register";
import { userMessage, type Message } from "./messages.ts";
import { deepSeekProvider } from "./providers/deepseek.ts";
import { isAbortError, streamModel } from "./stream.ts";

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
    const messages: Message[] = [userMessage(prompt)];
    for await (const event of streamModel(messages, deepSeekProvider, {
      apiKey,
      model: process.env.DEEPSEEK_MODEL,
      signal: controller.signal,
    })) {
      if (event.type === "text_delta") process.stdout.write(event.delta);
      if (event.type === "done") messages.push(event.message);
    }
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
