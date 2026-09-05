import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { mapLimit } from "./shared.ts";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Write a file beside its destination and publish it with one rename. */
export async function writeFileAtomically(path: string, contents: string | Uint8Array): Promise<void> {
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    const written = await Bun.write(temporaryPath, contents);
    if (written <= 0 && (typeof contents === "string" ? contents.length : contents.byteLength) > 0) {
      throw new Error(`写入临时文件失败：${temporaryPath}`);
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function directorySize(root: string): Promise<number> {
  let size = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directories = pending.splice(-32);
    const batches = await Promise.all(directories.map(async (directory) => ({
      directory,
      entries: await readdir(directory, { withFileTypes: true }),
    })));
    const files: string[] = [];
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    const sizes = await mapLimit(files, 32, async (path) => (await stat(path)).size);
    for (const fileSize of sizes) {
      size += fileSize;
      if (!Number.isSafeInteger(size)) throw new Error(`目录大小超过安全整数范围：${root}`);
    }
  }
  return size;
}
