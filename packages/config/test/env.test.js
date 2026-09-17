import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../src/env.js";

test("finds the nearest .env by walking up from any nested workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-pi-config-"));
  const nested = join(root, "apps", "demo");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, ".env"), "X_PI_CONFIG_SEARCH=found\n");

  const path = loadEnv(nested);

  assert.equal(path, join(root, ".env"));
  assert.equal(process.env.X_PI_CONFIG_SEARCH, "found");
  delete process.env.X_PI_CONFIG_SEARCH;
});

test("ENV_FILE can select a configuration file explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-pi-config-"));
  await writeFile(join(root, "custom.env"), "X_PI_CONFIG_EXPLICIT=found\n");
  process.env.ENV_FILE = "custom.env";

  const path = loadEnv(root);

  assert.equal(path, join(root, "custom.env"));
  assert.equal(process.env.X_PI_CONFIG_EXPLICIT, "found");
  delete process.env.ENV_FILE;
  delete process.env.X_PI_CONFIG_EXPLICIT;
});
