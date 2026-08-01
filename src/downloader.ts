import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { API_BASE_URL } from "./constants.ts";
import { fetchJson, fetchWorkByCode, workCodeFromSearchWork } from "./api.ts";
import { buildDownloadFilePlan, type DownloadFile, type TrackNode } from "./domain/archive.ts";
import { formatFileSize, hasReachedDownloadSizeLimit } from "./domain/size.ts";
import { formatWorkId } from "./domain/work-code.ts";
import { directorySize, pathExists } from "./fs-utils.ts";
import { containsPath, errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type {
  Config,
  DownloadBatchResult,
  DownloaderSettings,
  DownloadResult,
  DownloadTarget,
  RequestThrottle,
} from "./types.ts";

const parseTomlValue = (text: string, section: string, key: string): string | undefined => {
  let currentSection = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (currentSection !== section) continue;
    const valueMatch = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (valueMatch) return valueMatch[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
};

export async function readDownloaderSettings(workingDirectory: string, config: Config): Promise<DownloaderSettings> {
  const defaults: DownloaderSettings = {
    maxRetries: 3,
    maxWorkers: config.concurrency,
    proxyUrl: "",
    requestTimeoutMs: config.requestTimeoutMs,
    syncQps: 2,
  };
  const file = Bun.file(join(workingDirectory, ".asmroner-data", "config.toml"));
  if (!(await file.exists())) return defaults;
  const text = await file.text();
  const maxRetries = Number.parseInt(parseTomlValue(text, "downloader", "max_retries") ?? "", 10);
  const maxWorkers = Number.parseInt(parseTomlValue(text, "downloader", "max_workers") ?? "", 10);
  const syncQps = Number.parseFloat(parseTomlValue(text, "limit", "sync_qps") ?? "");
  return {
    ...defaults,
    ...(Number.isInteger(maxRetries) && maxRetries >= 0 ? { maxRetries: Math.min(maxRetries, 20) } : {}),
    ...(Number.isInteger(maxWorkers) && maxWorkers > 0 ? { maxWorkers: Math.min(maxWorkers, 20) } : {}),
    proxyUrl: parseTomlValue(text, "downloader", "proxy_url") || "",
    ...(Number.isFinite(syncQps) && syncQps > 0 ? { syncQps: Math.min(syncQps, 100) } : {}),
  };
}

export function isCompleteDownloadFile(actualSize: number, expectedSize?: number): boolean {
  return expectedSize === undefined || actualSize === expectedSize;
}

export async function ensureSafeDownloadDirectory(root: string, directory: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  if (!containsPath(resolvedRoot, resolvedDirectory)) throw new Error("下载路径越过了临时目录");

  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`下载临时路径不是普通文件夹：${resolvedRoot}`);

  let current = resolvedRoot;
  const relation = relative(resolvedRoot, resolvedDirectory);
  for (const segment of relation.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`下载路径包含链接或非文件夹组件：${current}`);
    }
  }
}

export async function writeResponseBodyToFile(
  response: Response,
  path: string,
  controller: AbortController,
  inactivityTimeoutMs: number,
): Promise<void> {
  if (!response.body) throw new Error("下载响应没有文件内容");
  if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new Error(`下载无数据超时必须是正数，实际为 ${inactivityTimeoutMs}`);
  }
  // Exclusive creation prevents a concurrently inserted symlink from being followed.
  const file = await open(path, "wx", 0o600);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let position = 0;
  let completed = false;
  try {
    reader = response.body.getReader();
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`连续 ${inactivityTimeoutMs} 毫秒没有收到下载数据`));
        }, inactivityTimeoutMs);
      });
      const chunk = await Promise.race([reader.read(), timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (chunk.done) {
        completed = true;
        break;
      }
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset, position);
        if (written.bytesWritten <= 0) throw new Error("无法继续写入下载文件");
        offset += written.bytesWritten;
        position += written.bytesWritten;
      }
    }
  } finally {
    if (reader) {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    await file.close();
  }
}

const downloadFile = async (file: DownloadFile, root: string, settings: DownloaderSettings): Promise<"downloaded" | "skipped"> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(file.url);
  } catch {
    throw new Error(`${file.relativePath}：下载地址无效`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${file.relativePath}：只允许 HTTP 或 HTTPS 下载地址`);
  }
  const targetPath = join(root, file.relativePath);
  const partialPath = `${targetPath}.asmr-archive-checker-part`;
  await ensureSafeDownloadDirectory(root, dirname(targetPath));
  if (await pathExists(targetPath)) {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink()) throw new Error(`${file.relativePath}：目标路径是符号链接`);
    if (existing.isFile() && isCompleteDownloadFile(existing.size, file.size)) return "skipped";
    if (!existing.isFile()) throw new Error(`${file.relativePath}：目标路径存在但不是文件`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (attempt > 0) {
        logger.warn(`重试 ${attempt}/${settings.maxRetries}：${file.relativePath}（${errorMessage(lastError)}）`);
        await Bun.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
      await rm(partialPath, { force: true });
      timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
      const response = await fetch(file.url, {
        headers: { "User-Agent": "asmr-archive-checker/1.0" },
        signal: controller.signal,
        ...(settings.proxyUrl ? { proxy: settings.proxyUrl } : {}),
      });
      clearTimeout(timer);
      timer = undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const lengthHeader = response.headers.has("content-encoding") ? null : response.headers.get("content-length");
      const responseSize = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
      if (responseSize !== undefined && (!Number.isSafeInteger(responseSize) || responseSize < 0)) {
        throw new Error(`响应文件大小无效：${lengthHeader}`);
      }
      if (file.size !== undefined && responseSize !== undefined && file.size !== responseSize) {
        throw new Error(`响应文件大小不符：预期 ${file.size}，响应声明 ${responseSize}`);
      }
      await writeResponseBodyToFile(response, partialPath, controller, settings.requestTimeoutMs);
      const expectedSize = file.size ?? responseSize;
      if (expectedSize !== undefined) {
        const actualSize = (await stat(partialPath)).size;
        if (actualSize !== expectedSize) {
          throw new Error(`文件大小不符：预期 ${expectedSize}，实际 ${actualSize}`);
        }
      }
      await rm(targetPath, { force: true });
      await rename(partialPath, targetPath);
      return "downloaded";
    } catch (error) {
      lastError = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  await rm(partialPath, { force: true }).catch(() => undefined);
  throw new Error(`${file.relativePath}：${errorMessage(lastError)}`);
};

export async function prepareStagingPath(stagingRoot: string, displayId: string): Promise<string> {
  const stablePath = join(stagingRoot, displayId);
  if (await pathExists(stablePath)) {
    const info = await lstat(stablePath);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`下载临时路径存在但不是普通文件夹：${stablePath}`);
    return stablePath;
  }
  const candidates = (await readdir(stagingRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${displayId}-`))
    .map((entry) => join(stagingRoot, entry.name));
  if (candidates.length > 0) {
    const selected = (await mapLimit(candidates, 8, async (path) => ({ path, size: await directorySize(path) })))
      .toSorted((left, right) => right.size - left.size)[0].path;
    await rename(selected, stablePath);
    logger.info(`继续上次下载：${stablePath}`);
    return stablePath;
  }
  await mkdir(stablePath);
  return stablePath;
}

/** @deprecated Use prepareStagingPath. */
export const prepareBuiltinStagingPath = prepareStagingPath;

const downloadWithBuiltin = async (
  workId: number,
  stagingPath: string,
  config: Config,
  settings: DownloaderSettings,
): Promise<void> => {
  const trackTree = await fetchJson<TrackNode[]>(`${API_BASE_URL}/api/tracks/${workId}?v=2`, config.requestTimeoutMs, 4, settings.proxyUrl);
  if (!Array.isArray(trackTree)) throw new Error("文件列表 API 返回了无法识别的数据结构");
  const files = buildDownloadFilePlan(trackTree);
  if (files.length === 0) throw new Error("网站文件列表为空，无法下载");
  logger.info(`内置下载器：全部 ${files.length} 个资源，并发 ${settings.maxWorkers}`);
  let finished = 0;
  let reused = 0;
  const errors = await mapLimit(files, settings.maxWorkers, async (file) => {
    try {
      const status = await downloadFile(file, stagingPath, settings);
      finished += 1;
      if (status === "skipped") reused += 1;
      logger.info(`[${finished}/${files.length}] ${status === "skipped" ? "已下载" : "完成"} ${file.relativePath}`);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  const failures = errors.filter((error): error is string => typeof error === "string");
  if (failures.length > 0) throw new Error(`${failures.length} 个文件下载失败；首个错误：${failures[0]}`);
  if (reused > 0) logger.info(`复用了 ${reused} 个已下载文件`);
};

const downloadWork = async (
  target: DownloadTarget,
  config: Config,
  settings?: DownloaderSettings,
): Promise<DownloadResult> => {
  const { workId, displayId } = target;
  const targetPath = join(config.downloadDir, displayId);
  if (await pathExists(targetPath)) {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) {
      return { workId, displayId, status: "failed", error: `目标路径是符号链接：${targetPath}` };
    }
    return info.isDirectory()
      ? { workId, displayId, status: "skipped", targetPath }
      : { workId, displayId, status: "failed", error: `目标路径存在但不是文件夹：${targetPath}` };
  }
  const stagingRoot = join(config.downloadDir, ".asmr-archive-checker-downloads");
  let stagingPath = join(stagingRoot, displayId);
  try {
    await mkdir(stagingRoot, { recursive: true });
    const stagingRootInfo = await lstat(stagingRoot);
    if (stagingRootInfo.isSymbolicLink() || !stagingRootInfo.isDirectory()) {
      throw new Error(`下载临时根路径不是普通文件夹：${stagingRoot}`);
    }
    stagingPath = await prepareStagingPath(stagingRoot, displayId);
    logger.info(`下载完整作品 ${displayId} ...`);
    await downloadWithBuiltin(workId, stagingPath, config, settings ?? await readDownloaderSettings(resolve("."), config));
    if (await pathExists(targetPath)) throw new Error(`目标文件夹已存在：${targetPath}`);
    const size = await directorySize(stagingPath);
    await rename(stagingPath, targetPath);
    return { workId, displayId, status: "downloaded", targetPath, size };
  } catch (error) {
    return { workId, displayId, status: "failed", stagingPath, error: errorMessage(error) };
  }
};

type NumericDownloadOne = (workId: number, config: Config) => Promise<DownloadResult>;
type TargetDownloadOne = (target: DownloadTarget, config: Config) => Promise<DownloadResult>;

export function downloadWorks(workIds: number[], config: Config, downloadOne?: NumericDownloadOne): Promise<DownloadBatchResult>;
export function downloadWorks(targets: DownloadTarget[], config: Config, downloadOne?: TargetDownloadOne): Promise<DownloadBatchResult>;
export async function downloadWorks(
  inputs: Array<number | DownloadTarget>,
  config: Config,
  downloadOne?: NumericDownloadOne | TargetDownloadOne,
): Promise<DownloadBatchResult> {
  const entries = [...new Map(inputs.map((input) => {
    const target = typeof input === "number" ? { workId: input, displayId: formatWorkId(input) } : input;
    return [`${target.workId}\0${target.displayId}`, { input, target }] as const;
  })).values()];
  const settings = !downloadOne
    ? await readDownloaderSettings(resolve("."), config)
    : undefined;
  const run = (entry: typeof entries[number]): Promise<DownloadResult> => {
    if (!downloadOne) return downloadWork(entry.target, config, settings);
    return typeof entry.input === "number"
      ? (downloadOne as NumericDownloadOne)(entry.input, config)
      : (downloadOne as TargetDownloadOne)(entry.input, config);
  };
  const runSafely = async (entry: typeof entries[number]): Promise<DownloadResult> => {
    try {
      return await run(entry);
    } catch (error) {
      return {
        ...entry.target,
        status: "failed",
        error: errorMessage(error),
      };
    }
  };
  const results: DownloadResult[] = [];
  let downloadedSize = 0;
  let stoppedByLimit = false;
  let attemptedCount = 0;
  let pendingRetryCount = 0;
  for (const [index, entry] of entries.entries()) {
    logger.info(`[作品 ${index + 1}/${entries.length}] ${entry.target.displayId}`);
    const result = await runSafely(entry);
    results.push(result);
    attemptedCount += 1;
    if (result.status === "downloaded") {
      downloadedSize += result.size ?? 0;
      logger.info(`作品完成：${result.displayId}（${formatFileSize(result.size ?? 0)}）`);
      if (hasReachedDownloadSizeLimit(downloadedSize, config.maxDownloadSizeBytes)) {
        const maxDownloadSize = config.maxDownloadSizeBytes;
        if (maxDownloadSize === undefined) throw new Error("下载体积限制状态不一致");
        stoppedByLimit = true;
        logger.info(`已达到本次下载体积限制：${formatFileSize(downloadedSize)} / ${formatFileSize(maxDownloadSize)}；当前作品已完整下载，停止后续下载。`);
        break;
      }
    } else if (result.status === "skipped") logger.info(`作品已存在，跳过：${result.displayId}`);
    else logger.error(`作品失败：${result.displayId}：${result.error}`);
  }
  const failedIndexes = results.flatMap((result, index) => result.status === "failed" ? [index] : []);
  if (!stoppedByLimit && failedIndexes.length > 0) {
    logger.warn(`首轮有 ${failedIndexes.length} 部作品失败，开始续传重试。`);
    for (const [retryIndex, resultIndex] of failedIndexes.entries()) {
      const entry = entries[resultIndex];
      logger.info(`[重试 ${retryIndex + 1}/${failedIndexes.length}] ${entry.target.displayId}`);
      const result = await runSafely(entry);
      results[resultIndex] = result;
      if (result.status === "downloaded") {
        downloadedSize += result.size ?? 0;
        logger.info(`重试完成：${result.displayId}（${formatFileSize(result.size ?? 0)}）`);
        if (hasReachedDownloadSizeLimit(downloadedSize, config.maxDownloadSizeBytes)) {
          const maxDownloadSize = config.maxDownloadSizeBytes;
          if (maxDownloadSize === undefined) throw new Error("下载体积限制状态不一致");
          stoppedByLimit = true;
          logger.info(
            `已达到本次下载体积限制：${formatFileSize(downloadedSize)} / ` +
            `${formatFileSize(maxDownloadSize)}；当前作品已完整下载，停止后续重试。`,
          );
          pendingRetryCount = failedIndexes.length - retryIndex - 1;
          break;
        }
      } else if (result.status === "skipped") {
        logger.info(`作品已存在，跳过：${result.displayId}`);
      } else {
        logger.error(`重试失败：${result.displayId}：${result.error}`);
      }
    }
  }
  const unattemptedCount = entries.length - attemptedCount;
  return {
    results,
    downloadedSize,
    stoppedByLimit,
    remainingCount: unattemptedCount + pendingRetryCount,
  };
}

export async function resolveDownloadTargets(
  workCodes: Array<number | string>,
  config: Config,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<DownloadTarget[]> {
  return mapLimit(workCodes, config.concurrency, async (input) => {
    const workCode = typeof input === "number" ? formatWorkId(input) : input;
    if (workCode.startsWith("RJ")) return { workId: Number(workCode.slice(2)), displayId: workCode };
    const work = await fetchWorkByCode(workCode, config, proxyUrl, throttle);
    return { workId: work.id, displayId: workCodeFromSearchWork(work) };
  }).then((targets) => [...new Map(targets.map((target) => [target.displayId, target])).values()]);
}
