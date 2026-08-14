import { basename, join } from "node:path";
import { createRequestThrottle, fetchAllWorks, workCodeFromSearchWork } from "./api.ts";
import { checkArchive, classifyArchives, findArchives, findDownloadedWorkFolders, scanLocalCollection } from "./archive-service.ts";
import { ensureDirectory, loadConfig, parseArgs, requireDirectory, usage, validateOutputDirectory } from "./config.ts";
import {
  DELETE_QUEUE_FILE_NAME,
  DOWNLOAD_QUEUE_FILE_NAME,
  NON_AUTHOR_FILE_NAME,
} from "./constants.ts";
import { previewAndDeleteIncomplete, previewAndDeleteNonAuthorWorks } from "./deletion.ts";
import { findNonAuthorWorks, parseDownloadQueue, type CodedLocalWork, type IncompleteArchive } from "./domain/records.ts";
import { formatFileSize } from "./domain/size.ts";
import { workCodeOf } from "./domain/work-code.ts";
import { downloadWorks, resolveDownloadTargets } from "./downloader.ts";
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
  const workCodes = parseDownloadQueue(queueText);
  await ensureDirectory(config.downloadDir, "downloadDir");
  await ensureDirectory(join(config.downloadDir, ".asmr-archive-checker-downloads"), "下载临时目录");
  const targets = await resolveDownloadTargets(
    workCodes,
    config,
    createRequestThrottle(config.syncQps),
  );
  await replaceOutputDirectory(config.outputDir, (stagingDir) => restoreOutputSnapshot(stagingDir, snapshot));
  logger.info("模式：download");
  logger.info(`下载目录：${config.downloadDir}`);
  logger.info(`待下载作品：${targets.length} 个`);
  logger.info(`本次下载体积限制：${config.maxDownloadSizeBytes === undefined ? "不限制" : formatFileSize(config.maxDownloadSizeBytes)}`);
  const batch = await downloadWorks(targets, config);
  const downloads = batch.results;
  logger.info(
    `本次结束：下载成功 ${downloads.filter((item) => item.status === "downloaded").length} 个，` +
    `已存在 ${downloads.filter((item) => item.status === "skipped").length} 个，` +
    `失败 ${downloads.filter((item) => item.status === "failed").length} 个，` +
    `下载体积 ${formatFileSize(batch.downloadedSize)}。`,
  );
  if (batch.stoppedByLimit && batch.remainingCount > 0) logger.info(`因达到体积限制停止，队列中还有 ${batch.remainingCount} 部作品未开始。`);
  if (batch.stoppedByServiceUnavailable && batch.remainingCount > 0) {
    logger.warn(`因资源服务器不可用停止，队列中还有 ${batch.remainingCount} 部作品未开始。`);
  }
  if (downloads.some((item) => item.status === "failed")) process.exitCode = 2;
};

const runCheck = async (
  mode: "author" | "archives",
  config: Config,
): Promise<void> => {
  await requireDirectory(config.archiveDir, "archiveDir");
  validateOutputDirectory(config);
  logger.info(`模式：${mode}`);
  if (mode === "author") logger.info(`作者：${config.author}`);
  logger.info(`7z 目录：${config.archiveDir}`);

  const extraFolderRoots = mode === "author"
    ? [...new Set([config.downloadDir].filter((root) => root && root !== config.archiveDir))]
    : [];
  const [localCollection, extraFolderGroups] = await Promise.all([
    mode === "author"
      ? scanLocalCollection(config.archiveDir)
      : findArchives(config.archiveDir).then((archives) => ({ archives, folders: [] })),
    Promise.all(extraFolderRoots.map(findDownloadedWorkFolders)),
  ]);
  const archivePaths = localCollection.archives;
  const downloadedFolders = [...new Map(
    [localCollection.folders, ...extraFolderGroups].flat().map((folder) => [folder.path, folder]),
  ).values()];
  const { recognized: recognizedArchives, unknown: unknownArchives } = classifyArchives(archivePaths);
  const apiThrottle = createRequestThrottle(config.syncQps);
  logger.info(`API 请求速率：每秒最多 ${config.syncQps} 次`);
  const works = mode === "author" ? await fetchAllWorks(config, apiThrottle) : [];
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

  logger.info(`${mode === "author" ? `网站作品：${works.length} 个；` : ""}找到 7z：${archivePaths.length} 个；需要核对：${archivesToCheck.length} 个`);
  if (unknownArchives.length > 0) logger.warn(`无法识别来源编号（*J）的 7z：${unknownArchives.length} 个`);
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
    );
  });
  const downloadedCodes = new Set([
    ...recognizedArchives.map(workCodeOf),
    ...downloadedFolders.map(workCodeOf),
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
  return runCheck(cli.mode, config);
}
