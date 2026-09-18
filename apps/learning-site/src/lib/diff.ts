import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { structuredPatch } from "diff";

// pnpm filter 会在站点 package 目录执行脚本；不要依赖 Astro 打包后的 import.meta.url。
const repoRoot = resolve(process.cwd(), "../..");

export type DiffRow = {
  kind: "add" | "remove" | "context";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  header: string;
  rows: DiffRow[];
};

export type FileDiff = {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

async function readLabFile(lab: string | undefined, path: string): Promise<string> {
  if (!lab) return "";
  try {
    return await readFile(join(repoRoot, "labs", lab, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function createFileDiffs(
  fromLab: string | undefined,
  toLab: string | undefined,
  files: string[],
): Promise<FileDiff[]> {
  if (!toLab) return [];

  return Promise.all(files.map(async (path) => {
    const [before, after] = await Promise.all([
      readLabFile(fromLab, path),
      readLabFile(toLab, path),
    ]);
    const patch = structuredPatch(
      fromLab ? `${fromLab}/${path}` : "/dev/null",
      `${toLab}/${path}`,
      before,
      after,
      "",
      "",
      { context: 3 },
    );
    let additions = 0;
    let deletions = 0;
    const hunks = patch.hunks.map((hunk) => {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const rows = hunk.lines.map((line): DiffRow => {
        const prefix = line[0];
        const text = line.slice(1);
        if (prefix === "+") {
          additions += 1;
          return { kind: "add", newLine: newLine++, text };
        }
        if (prefix === "-") {
          deletions += 1;
          return { kind: "remove", oldLine: oldLine++, text };
        }
        return {
          kind: "context",
          oldLine: oldLine++,
          newLine: newLine++,
          text,
        };
      });
      return {
        header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        rows,
      };
    });
    return { path, additions, deletions, hunks };
  }));
}
