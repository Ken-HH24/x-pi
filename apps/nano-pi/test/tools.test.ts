import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadFileTool, ToolRegistry, validateArguments } from "../src/tools.ts";

test("validates required fields, declared types, and additional properties", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
  assert.doesNotThrow(() => validateArguments(schema, { path: "README.md" }));
  assert.throws(() => validateArguments(schema, {}), /path is required/);
  assert.throws(() => validateArguments(schema, { path: 42 }), /path must be a string/);
  assert.throws(() => validateArguments(schema, { path: "README.md", extra: true }), /extra is not allowed/);
});

test("read_file accepts workspace relative files and rejects escapes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "x-pi-tools-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(join(root, "nested"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "nested", "note.txt"), "hello", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, join(root, "linked-out"), "dir");
  const tool = createReadFileTool(root);
  assert.equal(await tool.execute({ path: "nested/note.txt" }), "hello");
  await assert.rejects(async () => tool.execute({ path: "../outside/secret.txt" }), /escapes the workspace/);
  await assert.rejects(async () => tool.execute({ path: join(outside, "secret.txt") }), /must be relative/);
  await assert.rejects(async () => tool.execute({ path: "linked-out/secret.txt" }), /escapes the workspace/);
});

test("registry validates before executing and rejects duplicate names", async () => {
  let ran = false;
  const tool = {
    name: "demo", description: "demo", parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    execute: () => { ran = true; return "ok"; },
  };
  const registry = new ToolRegistry([tool]);
  await assert.rejects(() => registry.execute({ type: "toolCall", id: "c1", name: "demo", arguments: {} }), /value is required/);
  assert.equal(ran, false);
  assert.throws(() => new ToolRegistry([tool, tool]), /Duplicate tool/);
});
