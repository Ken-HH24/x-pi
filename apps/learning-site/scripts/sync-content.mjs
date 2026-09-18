import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const source = resolve(repoRoot, "chapters");
const target = resolve(here, "../src/content/chapters");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const markdown = await readFile(resolve(source, entry.name, "README.md"), "utf8");
  // 页面标题由站点布局呈现，生成副本时移除正文里的第一个 H1。
  const renderedMarkdown = markdown.replace(/\n# Chapter[^\n]*\n/, "\n");
  await writeFile(resolve(target, `${entry.name}.md`), renderedMarkdown);
}
