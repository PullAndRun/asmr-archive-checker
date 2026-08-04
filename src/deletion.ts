import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatFileSize } from "./domain/size.ts";
import { workCodeFromArchiveName, workCodeOf } from "./domain/work-code.ts";
import type { IncompleteArchive, NonAuthorWork } from "./domain/records.ts";
import { directorySize } from "./fs-utils.ts";
import { containsPath, errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type {
  Config,
  DeletionCandidate,
  DeletionFailure,
  NonAuthorDeletionCandidate,
  NonAuthorDeletionFailure,
} from "./types.ts";

type FileIdentity = {
  device: number | bigint;
  inode: number | bigint;
  size: number | bigint;
  modifiedAt: number | bigint;
  changedAt: number | bigint;
};

type DeletionMetadata = { canonicalPath: string; identity: FileIdentity };

const archiveDeletionMetadata = new WeakMap<DeletionCandidate, DeletionMetadata>();
const nonAuthorDeletionMetadata = new WeakMap<NonAuthorDeletionCandidate, DeletionMetadata>();

const fileIdentity = (info: Awaited<ReturnType<typeof lstat>>): FileIdentity => ({
  device: info.dev,
  inode: info.ino,
  size: info.size,
  modifiedAt: info.mtimeMs,
  changedAt: info.ctimeMs,
});

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedAt === right.modifiedAt &&
  left.changedAt === right.changedAt;

export async function buildDeletionPlan(incomplete: IncompleteArchive[], archiveDir: string): Promise<DeletionCandidate[]> {
  const root = resolve(archiveDir);
  const canonicalRoot = await realpath(root);
  const resolved = await mapLimit(incomplete.filter((item) => !item.error && item.missingFiles.length > 0), 16, async (item) => {
    const archivePath = resolve(item.archivePath);
    if (!containsPath(root, archivePath) || archivePath === root) throw new Error(`拒绝删除 archiveDir 之外的文件：${archivePath}`);
    if (extname(archivePath).toLowerCase() !== ".7z") throw new Error(`拒绝删除非 7z 文件：${archivePath}`);
    const info = await lstat(archivePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`删除候选不是普通文件：${archivePath}`);
    const canonicalPath = await realpath(archivePath);
    if (!containsPath(canonicalRoot, canonicalPath) || canonicalPath === canonicalRoot) {
      throw new Error(`拒绝删除 archiveDir 之外的文件：${archivePath}`);
    }
    return { archivePath, canonicalPath, identity: fileIdentity(info), workCode: workCodeOf(item), size: info.size };
  });
  const candidates = new Map<string, typeof resolved[number]>();
  for (const candidate of resolved) {
    const key = process.platform === "win32" ? candidate.canonicalPath.toLowerCase() : candidate.canonicalPath;
    const existing = candidates.get(key);
    if (existing && workCodeOf(existing) !== workCodeOf(candidate)) {
      throw new Error(`待删除清单对同一文件存在冲突记录：${candidate.archivePath}`);
    }
    candidates.set(key, candidate);
  }
  return [...candidates.values()].map(({ canonicalPath, identity, ...candidate }) => {
    archiveDeletionMetadata.set(candidate, { canonicalPath, identity });
    return candidate;
  });
}

export async function deleteArchives(candidates: DeletionCandidate[]): Promise<DeletionFailure[]> {
  const failures: DeletionFailure[] = [];
  for (const candidate of candidates) {
    try {
      const metadata = archiveDeletionMetadata.get(candidate);
      if (!metadata) throw new Error("删除候选缺少安全规划信息，请重新生成删除计划");
      const info = await lstat(candidate.archivePath);
      if (info.isSymbolicLink() || !info.isFile() || extname(candidate.archivePath).toLowerCase() !== ".7z") {
        throw new Error("目标不再是普通 7z 文件");
      }
      const actualCode = workCodeFromArchiveName(candidate.archivePath);
      if (actualCode !== workCodeOf(candidate)) throw new Error("目标作品编号已变化");
      const canonicalPath = await realpath(candidate.archivePath);
      if (!samePath(canonicalPath, metadata.canonicalPath) || !sameIdentity(fileIdentity(info), metadata.identity)) {
        throw new Error("目标在删除确认期间已被替换或修改");
      }
      await unlink(candidate.archivePath);
    } catch (error) {
      failures.push({ archivePath: candidate.archivePath, error: errorMessage(error) });
    }
  }
  return failures;
}

export async function buildNonAuthorDeletionPlan(
  works: NonAuthorWork[],
  archiveDir: string,
  downloadDir = "",
): Promise<NonAuthorDeletionCandidate[]> {
  const archiveRoot = resolve(archiveDir);
  const folderRoots = [archiveRoot, ...(downloadDir ? [resolve(downloadDir)] : [])];
  const canonicalRoots = await Promise.all(folderRoots.map(async (path) => ({ path, canonicalPath: await realpath(path) })));
  const resolved = await mapLimit(works, 16, async (work) => {
    const targetPath = resolve(work.path);
    const allowedRoots = work.type === "压缩包" ? canonicalRoots.slice(0, 1) : canonicalRoots;
    if (!allowedRoots.some((root) => targetPath !== root.path && containsPath(root.path, targetPath))) {
      throw new Error(`拒绝删除允许目录之外的${work.type}：${targetPath}`);
    }
    const expectedCode = workCodeOf(work);
    const targetCode = workCodeFromArchiveName(work.type === "文件夹" ? `${basename(targetPath)}.7z` : targetPath);
    if (targetCode !== expectedCode) throw new Error(`删除目标的作品编号与清单不一致：${targetPath}`);
    const info = await lstat(targetPath).catch((error) => {
      throw new Error(`无法使用删除目标 ${targetPath}：${errorMessage(error)}`);
    });
    if (info.isSymbolicLink()) throw new Error(`拒绝删除符号链接：${targetPath}`);
    const canonicalPath = await realpath(targetPath);
    if (!allowedRoots.some((root) => canonicalPath !== root.canonicalPath && containsPath(root.canonicalPath, canonicalPath))) {
      throw new Error(`拒绝删除允许目录之外的${work.type}：${targetPath}`);
    }
    if (work.type === "压缩包" && (extname(targetPath).toLowerCase() !== ".7z" || !info.isFile())) {
      throw new Error(`删除目标不是普通 7z 文件：${targetPath}`);
    }
    if (work.type === "文件夹" && (!/^[A-Z]J\d+$/i.test(basename(targetPath)) || !info.isDirectory())) {
      throw new Error(`删除目标不是标准作品文件夹：${targetPath}`);
    }
    return {
      ...work,
      path: targetPath,
      canonicalPath,
      identity: fileIdentity(info),
      size: work.type === "压缩包" ? info.size : await directorySize(targetPath),
    };
  });

  const candidates = new Map<string, typeof resolved[number]>();
  resolved.forEach((candidate) => {
    const key = process.platform === "win32" ? candidate.canonicalPath.toLowerCase() : candidate.canonicalPath;
    const existing = candidates.get(key);
    const codeOf = (item: NonAuthorWork): string => workCodeOf(item);
    if (existing && (codeOf(existing) !== codeOf(candidate) || existing.type !== candidate.type)) {
      throw new Error(`待删除清单对同一路径存在冲突记录：${candidate.path}`);
    }
    candidates.set(key, candidate);
  });
  const planned = [...candidates.values()];
  return planned
    .filter((candidate) => !planned.some((parent) =>
      parent.type === "文件夹" &&
      parent.canonicalPath !== candidate.canonicalPath &&
      containsPath(parent.canonicalPath, candidate.canonicalPath)
    ))
    .map(({ canonicalPath, identity, ...candidate }) => {
      nonAuthorDeletionMetadata.set(candidate, { canonicalPath, identity });
      return candidate;
    });
}

export async function deleteNonAuthorWorks(candidates: NonAuthorDeletionCandidate[]): Promise<NonAuthorDeletionFailure[]> {
  const failures: NonAuthorDeletionFailure[] = [];
  for (const candidate of candidates) {
    try {
      const metadata = nonAuthorDeletionMetadata.get(candidate);
      if (!metadata) throw new Error("删除候选缺少安全规划信息，请重新生成删除计划");
      const info = await lstat(candidate.path);
      if (info.isSymbolicLink()) throw new Error("目标已变为符号链接");
      const actualCode = workCodeFromArchiveName(
        candidate.type === "文件夹" ? `${basename(candidate.path)}.7z` : candidate.path,
      );
      if (actualCode !== workCodeOf(candidate)) throw new Error("目标作品编号已变化");
      const canonicalPath = await realpath(candidate.path);
      if (!samePath(canonicalPath, metadata.canonicalPath) || !sameIdentity(fileIdentity(info), metadata.identity)) {
        throw new Error("目标在删除确认期间已被替换或修改");
      }
      if (candidate.type === "压缩包") {
        if (!info.isFile() || extname(candidate.path).toLowerCase() !== ".7z") throw new Error("目标不再是普通 7z 文件");
        await unlink(candidate.path);
      } else {
        if (!info.isDirectory()) throw new Error("目标不再是文件夹");
        await rm(candidate.path, { recursive: true, force: false });
      }
    } catch (error) {
      failures.push({ path: candidate.path, error: errorMessage(error) });
    }
  }
  return failures;
}

const confirmDeletion = async (count: number, noun = "文件"): Promise<boolean> => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(`确认永久删除以上 ${count} 个${noun}？输入 DELETE 继续：`)).trim() === "DELETE";
  } finally {
    readline.close();
  }
};

export async function previewAndDeleteIncomplete(incomplete: IncompleteArchive[], config: Config): Promise<void> {
  const candidates = await buildDeletionPlan(incomplete, config.archiveDir);
  const totalSize = candidates.reduce((sum, item) => sum + item.size, 0);
  logger.info("删除预览：");
  logger.info(`确认不完整：${candidates.length} 个`);
  logger.info(`文件总大小：${formatFileSize(totalSize)}（${totalSize} 字节）`);
  if (candidates.length === 0) return void logger.info("没有确认不完整的压缩包可删除。");
  logger.info("文件列表：");
  candidates.forEach((candidate, index) => logger.info(`${index + 1}. [${formatFileSize(candidate.size)}] ${candidate.archivePath}`));
  if (!(await confirmDeletion(candidates.length))) return void logger.info("已取消，未删除任何文件。");
  const failures = await deleteArchives(candidates);
  const deleted = candidates.filter((candidate) => !failures.some((failure) => failure.archivePath === candidate.archivePath));
  logger.info(`删除完成：成功 ${deleted.length} 个，失败 ${failures.length} 个，释放 ${formatFileSize(deleted.reduce((sum, item) => sum + item.size, 0))}。`);
  failures.forEach((failure) => logger.error(`删除失败：${failure.archivePath}：${failure.error}`));
  if (failures.length > 0) process.exitCode = 2;
}

export async function previewAndDeleteNonAuthorWorks(works: NonAuthorWork[], config: Config): Promise<void> {
  const candidates = await buildNonAuthorDeletionPlan(works, config.archiveDir, config.downloadDir);
  const archiveCount = candidates.filter((item) => item.type === "压缩包").length;
  const totalSize = candidates.reduce((sum, item) => sum + item.size, 0);
  logger.info("删除预览：");
  logger.info(`非该作者作品：${candidates.length} 项（压缩包 ${archiveCount} 个，文件夹 ${candidates.length - archiveCount} 个）`);
  logger.info(`总大小：${formatFileSize(totalSize)}（${totalSize} 字节）`);
  if (candidates.length === 0) return void logger.info("没有非该作者作品可删除。");
  candidates.forEach((candidate, index) => logger.info(
    `${index + 1}. [${candidate.type}] [${formatFileSize(candidate.size)}] ${workCodeOf(candidate)} ${candidate.path}`,
  ));
  if (!(await confirmDeletion(candidates.length, "项目"))) return void logger.info("已取消，未删除任何内容。");
  const failures = await deleteNonAuthorWorks(candidates);
  const deleted = candidates.filter((candidate) => !failures.some((failure) => failure.path === candidate.path));
  logger.info(`删除完成：成功 ${deleted.length} 项，失败 ${failures.length} 项，释放 ${formatFileSize(deleted.reduce((sum, item) => sum + item.size, 0))}。`);
  failures.forEach((failure) => logger.error(`删除失败：${failure.path}：${failure.error}`));
  if (failures.length > 0) process.exitCode = 2;
}
