import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function findUp(filename, startDirectory) {
  let directory = resolve(startDirectory);
  while (true) {
    const candidate = join(directory, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function loadEnv(startDirectory = process.cwd()) {
  const explicit = process.env.ENV_FILE;
  const path = explicit
    ? (isAbsolute(explicit) ? explicit : resolve(startDirectory, explicit))
    : findUp(".env", startDirectory);

  if (path && existsSync(path)) process.loadEnvFile(path);
  return path;
}
