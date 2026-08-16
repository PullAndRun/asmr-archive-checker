import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DELETE_QUEUE_FILE_NAME,
  DOWNLOAD_QUEUE_FILE_NAME,
  INCOMPLETE_FILE_NAME,
  MISSING_FILE_NAME,
  NON_AUTHOR_FILE_NAME,
} from "./constants.ts";
import {
  buildDeletionQueue,
  buildNonAuthorWorkList,
  parseDeletionQueue,
  parseNonAuthorWorkList,
  sanitizeColumn,
  type IncompleteArchive,
  type LocalWork,
  type NonAuthorWork,
} from "./domain/records.ts";
import { workCodeFromMetadata, workCodeOf } from "./domain/work-code.ts";
import { errorMessage } from "./shared.ts";
import { logger } from "./logger.ts";
import type { Config, SearchWork } from "./types.ts";

export async function readDeletionQueue(outputDir: string): Promise<IncompleteArchive[]> {
  const path = join(outputDir, DELETE_QUEUE_FILE_NAME);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`未找到待删除清单：${path}，请先重新运行 author 或 archives 模式`);
  return parseDeletionQueue(await file.text());
}

export async function readNonAuthorWorkList(outputDir: string): Promise<NonAuthorWork[]> {
  const path = join(outputDir, NON_AUTHOR_FILE_NAME);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`未找到非该作者作品清单：${path}，请先运行 author 模式`);
  return parseNonAuthorWorkList(await file.text());
}

export async function readOutputSnapshot(outputDir: string): Promise<Map<string, string>> {
  const names = [INCOMPLETE_FILE_NAME, MISSING_FILE_NAME, DOWNLOAD_QUEUE_FILE_NAME, DELETE_QUEUE_FILE_NAME, NON_AUTHOR_FILE_NAME];
  const entries = await Promise.all(names.map(async (name) => {
    const file = Bun.file(join(outputDir, name));
    return await file.exists() ? [name, await file.text()] as const : undefined;
  }));
  const snapshot = new Map(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
  if (!snapshot.has(DOWNLOAD_QUEUE_FILE_NAME)) {
    throw new Error(`未找到待下载汇总：${join(outputDir, DOWNLOAD_QUEUE_FILE_NAME)}，请先运行 author 或 archives 模式`);
  }
  return snapshot;
}

export async function restoreOutputSnapshot(outputDir: string, snapshot: Map<string, string>): Promise<void> {
  await Promise.all([...snapshot].map(([name, contents]) => Bun.write(join(outputDir, name), contents)));
}

export async function replaceOutputDirectory(
  outputDir: string,
  write: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(outputDir);
  const stagingDir = join(parent, `.${basename(outputDir)}.staging-${crypto.randomUUID()}`);
  const backupDir = join(parent, `.${basename(outputDir)}.backup-${crypto.randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });
  let hasBackup = false;
  try {
    await write(stagingDir);
    let outputExists = true;
    try {
      await lstat(outputDir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") outputExists = false;
      else throw error;
    }
    if (outputExists) {
      await rename(outputDir, backupDir);
      hasBackup = true;
    }
    try {
      await rename(stagingDir, outputDir);
    } catch (error) {
      if (hasBackup) {
        try {
          await rename(backupDir, outputDir);
        } catch (restoreError) {
          throw new Error(
            `无法替换结果目录，自动恢复也失败；原结果保留在 ${backupDir}：` +
            `${errorMessage(restoreError)}（初始错误：${errorMessage(error)}）`,
          );
        }
      }
      throw error;
    }
    if (hasBackup) {
      await rm(backupDir, { recursive: true, force: true }).catch((error) => {
        logger.warn(`结果目录已更新，但无法清理旧结果 ${backupDir}：${errorMessage(error)}`);
      });
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeResults(
  config: Config,
  works: SearchWork[],
  recognizedArchives: LocalWork[],
  incomplete: IncompleteArchive[],
  downloadedFolders: LocalWork[],
  nonAuthorWorks?: NonAuthorWork[],
  savedArchives: LocalWork[] = [],
): Promise<void> {
  await mkdir(config.outputDir, { recursive: true });
  const savedCodes = new Set(savedArchives.map(workCodeOf));
  const downloadedCodes = new Set([...recognizedArchives, ...downloadedFolders, ...savedArchives].map(workCodeOf));
  const missingWorks = works.filter((work) => !downloadedCodes.has(workCodeFromMetadata(work)));
  const missingLines = [
    "作品ID\t标题\t发布日期",
    ...missingWorks.map((work) =>
      `${workCodeFromMetadata(work)}\t${sanitizeColumn(work.title)}\t${sanitizeColumn(work.release)}`
    ),
  ];
  const queue = new Map<string, string>();
  incomplete.forEach((item) => {
    const workCode = workCodeOf(item);
    if (savedCodes.has(workCode)) return;
    queue.set(workCode, `${workCode}\t${item.error ? "检查失败" : "不完整"}\t${sanitizeColumn(item.archivePath)}`);
  });
  missingWorks.forEach((work) => {
    const workCode = workCodeFromMetadata(work);
    if (!queue.has(workCode)) queue.set(workCode, `${workCode}\t遗漏\t${sanitizeColumn(work.title)}`);
  });

  const writes: Array<Promise<number>> = [
    Bun.write(join(config.outputDir, INCOMPLETE_FILE_NAME), incomplete.length > 0 ? `${incomplete.map((item) => item.archivePath).join("\n")}\n` : ""),
    Bun.write(join(config.outputDir, MISSING_FILE_NAME), `${missingLines.join("\n")}\n`),
    Bun.write(join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME), `${["作品ID\t原因\t来源", ...queue.values()].join("\n")}\n`),
    Bun.write(join(config.outputDir, DELETE_QUEUE_FILE_NAME), buildDeletionQueue(incomplete)),
  ];
  if (nonAuthorWorks !== undefined) {
    writes.push(Bun.write(join(config.outputDir, NON_AUTHOR_FILE_NAME), buildNonAuthorWorkList(nonAuthorWorks)));
  }
  await Promise.all(writes);
}
