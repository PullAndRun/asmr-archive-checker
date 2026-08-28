import { basename, join, resolve } from "node:path";
import { createRequestThrottle, fetchAllWorks, workCodeFromSearchWork } from "./api.ts";
import { checkArchive, classifyArchives, findArchivesInRoots, findDownloadedWorkFolders } from "./archive-service.ts";
import { sanitizeDownloadPathSegment } from "./domain/archive.ts";
import { ensureDirectory, loadConfig, parseArgs, requireDirectory, usage, validateOutputDirectory } from "./config.ts";
import {
  DELETE_QUEUE_FILE_NAME,
  DOWNLOAD_QUEUE_FILE_NAME,
  MISSING_FILE_NAME,
  NON_AUTHOR_FILE_NAME,
} from "./constants.ts";
import { previewAndDeleteIncomplete, previewAndDeleteNonAuthorWorks } from "./deletion.ts";
import { findNonAuthorWorks, parseDownloadQueue, removeDownloadQueueEntry, removeMissingWorkEntry, type CodedLocalWork, type IncompleteArchive } from "./domain/records.ts";
import { formatFileSize } from "./domain/size.ts";
import { workCodeOf } from "./domain/work-code.ts";
import { downloadWorks, isDownloadTargetComplete, resolveDownloadTargets } from "./downloader.ts";
import {
  readDeletionQueue,
  readNonAuthorWorkList,
  readOutputSnapshot,
  restoreOutputSnapshot,
  replaceOutputDirectory,
  writeResults,
} from "./results-store.ts";
import { mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type { Config } from "./types.ts";
import { runAuthorFind } from "./author-sync.ts";

const runDelete = async (config: Config): Promise<void> => {
  await requireDirectory(config.archiveDir, "archiveDir");
  await requireDirectory(config.outputDir, "outputDir");
  logger.info("模式：delete");
  logger.info(`读取检查结果：${join(config.outputDir, DELETE_QUEUE_FILE_NAME)}`);
  await previewAndDeleteIncomplete(await readDeletionQueue(config.outputDir), config);
  logger.info(`结果目录：${config.outputDir}`);
};

const runDeleteNonAuthor = async (config: Config): Promise<void> => {
  await requireDirectory(config.archiveDir, "archiveDir");
  await requireDirectory(config.outputDir, "outputDir");
  logger.info("模式：delete-non-author");
  logger.info(`读取检查结果：${join(config.outputDir, NON_AUTHOR_FILE_NAME)}`);
  await previewAndDeleteNonAuthorWorks(await readNonAuthorWorkList(config.outputDir), config);
  logger.info(`结果清单保留在：${join(config.outputDir, NON_AUTHOR_FILE_NAME)}`);
};

const runDownload = async (config: Config): Promise<void> => {
  validateOutputDirectory(config);
  await ensureDirectory(config.outputDir, "outputDir");
  const snapshot = await readOutputSnapshot(config.outputDir);
  const queueText = snapshot.get(DOWNLOAD_QUEUE_FILE_NAME);
  if (queueText === undefined) throw new Error("待下载汇总快照缺失");
  let remainingQueueText = queueText;
  let remainingMissingText = snapshot.get(MISSING_FILE_NAME);
  const authorName = config.author.trim();
  const authorFolder = authorName
    ? join(config.downloadDir, sanitizeDownloadPathSegment(authorName))
    : config.downloadDir;
  const downloadedFoldersAtStart = await findDownloadedWorkFolders(authorFolder);
  let cleanedAtStart = 0;
  for (const folder of downloadedFoldersAtStart) {
    const completedCode = workCodeOf(folder);
    const nextQueueText = removeDownloadQueueEntry(remainingQueueText, completedCode);
    const nextMissingText = remainingMissingText === undefined
      ? undefined
      : removeMissingWorkEntry(remainingMissingText, completedCode);
    if (nextQueueText === remainingQueueText && nextMissingText === remainingMissingText) continue;
    remainingQueueText = nextQueueText;
    remainingMissingText = nextMissingText;
    cleanedAtStart += 1;
  }
  snapshot.set(DOWNLOAD_QUEUE_FILE_NAME, remainingQueueText);
  if (remainingMissingText !== undefined) snapshot.set(MISSING_FILE_NAME, remainingMissingText);
  const workCodes = parseDownloadQueue(remainingQueueText);
  await ensureDirectory(config.downloadDir, "downloadDir");
  await ensureDirectory(join(config.downloadDir, ".asmr-archive-checker-downloads"), "下载临时目录");
  const targets = await resolveDownloadTargets(
    workCodes,
    config,
    createRequestThrottle(config.syncQps),
    config.author,
  );
  await replaceOutputDirectory(config.outputDir, (stagingDir) => restoreOutputSnapshot(stagingDir, snapshot));
  const completeAtStart = await mapLimit(
    targets,
    config.concurrency,
    (target) => isDownloadTargetComplete(target, config.downloadDir),
  );
  const pendingTargets = [];
  for (const [index, target] of targets.entries()) {
    if (completeAtStart[index]) {
      const nextQueueText = removeDownloadQueueEntry(remainingQueueText, target.displayId);
      const nextMissingText = remainingMissingText === undefined
        ? undefined
        : removeMissingWorkEntry(remainingMissingText, target.displayId);
      if (nextQueueText !== remainingQueueText || nextMissingText !== remainingMissingText) {
        remainingQueueText = nextQueueText;
        remainingMissingText = nextMissingText;
        cleanedAtStart += 1;
      }
    } else {
      pendingTargets.push(target);
    }
  }
  if (cleanedAtStart > 0) {
    const writes = [Bun.write(join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME), remainingQueueText)];
    if (remainingMissingText !== undefined) writes.push(Bun.write(join(config.outputDir, MISSING_FILE_NAME), remainingMissingText));
    await Promise.all(writes);
    logger.info(`启动时发现 ${cleanedAtStart} 部已完成作品，已从待下载和遗漏清单移除`);
  }
  logger.info("模式：download");
  logger.info(`下载目录：${config.downloadDir}`);
  logger.info(`待下载作品：${pendingTargets.length} 个`);
  logger.info(`本次下载体积限制：${config.maxDownloadSizeBytes === undefined ? "不限制" : formatFileSize(config.maxDownloadSizeBytes)}`);
  const batch = await downloadWorks(pendingTargets, config, undefined, {
    retryFailedWorks: false,
    onDownloaded: async (result) => {
      const nextQueueText = removeDownloadQueueEntry(remainingQueueText, result.displayId);
      const nextMissingText = remainingMissingText === undefined
        ? undefined
        : removeMissingWorkEntry(remainingMissingText, result.displayId);
      if (nextQueueText === remainingQueueText && nextMissingText === remainingMissingText) return;
      const writes = [Bun.write(join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME), nextQueueText)];
      if (nextMissingText !== undefined) writes.push(Bun.write(join(config.outputDir, MISSING_FILE_NAME), nextMissingText));
      await Promise.all(writes);
      remainingQueueText = nextQueueText;
      remainingMissingText = nextMissingText;
    },
  });
  const downloads = batch.results;
  for (const result of downloads) {
    if (result.status !== "skipped") continue;
    const nextQueueText = removeDownloadQueueEntry(remainingQueueText, result.displayId);
    const nextMissingText = remainingMissingText === undefined
      ? undefined
      : removeMissingWorkEntry(remainingMissingText, result.displayId);
    if (nextQueueText === remainingQueueText && nextMissingText === remainingMissingText) continue;
    const writes = [Bun.write(join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME), nextQueueText)];
    if (nextMissingText !== undefined) writes.push(Bun.write(join(config.outputDir, MISSING_FILE_NAME), nextMissingText));
    await Promise.all(writes);
    remainingQueueText = nextQueueText;
    remainingMissingText = nextMissingText;
  }
  logger.info(
    `本次结束：下载成功 ${downloads.filter((item) => item.status === "downloaded").length} 个，` +
    `已存在 ${downloads.filter((item) => item.status === "skipped").length} 个，` +
    `站点暂无资源 ${downloads.filter((item) => item.status === "unavailable").length} 个，` +
    `失败 ${downloads.filter((item) => item.status === "failed").length} 个，` +
    `下载体积 ${formatFileSize(batch.downloadedSize)}。`,
  );
  if (batch.stoppedByLimit && batch.remainingCount > 0) logger.info(`因达到体积限制停止，队列中还有 ${batch.remainingCount} 部作品未开始。`);
  if (batch.stoppedByServiceUnavailable && batch.remainingCount > 0) {
    logger.warn(`因资源服务器不可用停止，队列中还有 ${batch.remainingCount} 部作品未开始。`);
  }
  if (batch.stoppedByRateLimit && batch.remainingCount > 0) {
    logger.warn(`因媒体服务器限流停止，队列中还有 ${batch.remainingCount} 部作品未开始；请等待限流窗口结束后再运行。`);
  }
  if (downloads.some((item) => item.status === "failed")) process.exitCode = 2;
};

const runCheck = async (
  mode: "author" | "archives",
  config: Config,
): Promise<void> => {
  await Promise.all([
    requireDirectory(config.archiveDir, "archiveDir"),
    requireDirectory(config.asmrDir, "asmrDir"),
  ]);
  validateOutputDirectory(config);
  logger.info(`模式：${mode}`);
  if (mode === "author") logger.info(`作者：${config.author}`);
  logger.info(`7z 目录：${config.archiveDir}`);
  logger.info(`ASMR 资料库：${config.asmrDir}`);

  const apiThrottle = createRequestThrottle(config.syncQps);
  logger.info(`API 请求速率：每秒最多 ${config.syncQps} 次`);
  const extraFolderRoots = mode === "author"
    ? [...new Set([config.downloadDir].filter((root) => root && root !== config.archiveDir))]
    : [];
  const scanStartedAt = performance.now();
  const localScan = Promise.all([
    findArchivesInRoots([config.archiveDir, config.asmrDir]),
    mode === "author" ? Promise.all([config.archiveDir, ...extraFolderRoots].map(findDownloadedWorkFolders)) : [],
  ]).then(([archiveGroups, folderGroups]) => ({
    archiveGroups,
    folderGroups,
    elapsedMs: performance.now() - scanStartedAt,
  }));
  const [{ archiveGroups: [archivePaths, savedArchivePaths], folderGroups, elapsedMs }, works] = await Promise.all([
    localScan,
    mode === "author" ? fetchAllWorks(config, apiThrottle) : Promise.resolve([]),
  ]);
  const downloadedFolders = [...new Map(
    folderGroups.flat().map((folder) => [folder.path, folder]),
  ).values()];
  logger.info(`本地文件查询完成：${elapsedMs.toFixed(0)} 毫秒`);
  const { recognized: recognizedArchives, unknown: unknownArchives } = classifyArchives(archivePaths);
  const checkedPathKeys = new Set(archivePaths.map((path) => {
    const key = resolve(path);
    return process.platform === "win32" ? key.toLowerCase() : key;
  }));
  const { recognized: allSavedArchives, unknown: unknownSavedArchives } = classifyArchives(savedArchivePaths);
  const savedArchives = allSavedArchives.filter((archive) => {
    const key = resolve(archive.path);
    return !checkedPathKeys.has(process.platform === "win32" ? key.toLowerCase() : key);
  });
  const websiteWorks = new Map(works.map((work) => [workCodeFromSearchWork(work), work]));
  const websiteCodes = new Set(websiteWorks.keys());
  const archivesToCheck: CodedLocalWork[] = mode === "author"
    ? recognizedArchives
      .flatMap((archive) => {
        const websiteWork = websiteWorks.get(archive.workCode);
        return websiteWork ? [{ ...archive, workId: websiteWork.id }] : [];
      })
    : recognizedArchives;
  const nonAuthorWorks = mode === "author"
    ? findNonAuthorWorks(websiteCodes, recognizedArchives, downloadedFolders)
    : undefined;

  logger.info(`${mode === "author" ? `网站作品：${works.length} 个；` : ""}找到 7z：${archivePaths.length} 个；ASMR 资料库已有：${new Set(allSavedArchives.map(workCodeOf)).size} 部；需要核对：${archivesToCheck.length} 个`);
  if (unknownArchives.length > 0) logger.warn(`无法识别来源编号（*J）的 7z：${unknownArchives.length} 个`);
  if (unknownSavedArchives.length > 0) logger.warn(`ASMR 资料库中无法识别来源编号（*J）的 7z：${unknownSavedArchives.length} 个`);
  const checked = await mapLimit(archivesToCheck, config.concurrency, async (archive, index) => {
    logger.info(`[${index + 1}/${archivesToCheck.length}] 检查 ${basename(archive.path)}`);
    return checkArchive(
      archive.path,
      archive.workCode,
      config,
      archive.workId,
      apiThrottle,
    );
  });
  const incomplete = checked.filter((item): item is IncompleteArchive => item !== undefined);
  await replaceOutputDirectory(config.outputDir, async (stagingDir) => {
    await writeResults(
      { ...config, outputDir: stagingDir },
      works,
      recognizedArchives,
      incomplete,
      downloadedFolders,
      nonAuthorWorks,
      savedArchives,
    );
  });
  const downloadedCodes = new Set([
    ...recognizedArchives.map(workCodeOf),
    ...downloadedFolders.map(workCodeOf),
    ...savedArchives.map(workCodeOf),
  ]);
  const missingCount = works.filter((work) => !downloadedCodes.has(workCodeFromSearchWork(work))).length;
  logger.info(`完成：不完整压缩包 ${incomplete.length} 个，遗漏下载作品 ${missingCount} 个。`);
  if (nonAuthorWorks !== undefined) {
    logger.info(`非该作者作品 ${new Set(nonAuthorWorks.map((work) => work.workCode)).size} 部（${nonAuthorWorks.length} 个本地压缩包或文件夹）：${join(config.outputDir, NON_AUTHOR_FILE_NAME)}`);
  }
  logger.info(`待下载汇总：${join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME)}`);
  logger.info(`结果目录：${config.outputDir}`);
  if (incomplete.some((item) => item.error)) process.exitCode = 2;
};

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const cli = parseArgs(args);
  if (cli.help) return void logger.info(usage());
  const config = await loadConfig(cli);
  if (cli.mode === "delete") return runDelete(config);
  if (cli.mode === "delete-non-author") return runDeleteNonAuthor(config);
  if (cli.mode === "download") return runDownload(config);
  if (cli.mode === "find") {
    const report = await runAuthorFind(config);
    if (report.errors.length > 0 || report.skippedAuthors.length > 0) process.exitCode = 2;
    return;
  }
  return runCheck(cli.mode, config);
}
