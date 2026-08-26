import { lstat, mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { API_BASE_URL } from "./constants.ts";
import { fetchJson, fetchWorkByCode, workCodeFromSearchWork } from "./api.ts";
import { buildDownloadFilePlan, sanitizeDownloadPathSegment, type DownloadFile, type TrackNode } from "./domain/archive.ts";
import { formatFileSize, hasReachedDownloadSizeLimit } from "./domain/size.ts";
import { formatWorkId } from "./domain/work-code.ts";
import { directorySize, pathExists } from "./fs-utils.ts";
import { findHttpResponseError, httpErrorFromResponse } from "./http.ts";
import { containsPath, errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type {
  Config,
  DownloadBatchResult,
  DownloadResult,
  DownloadTarget,
  RequestThrottle,
} from "./types.ts";

export function isCompleteDownloadFile(actualSize: number, expectedSize?: number): boolean {
  return expectedSize === undefined || actualSize === expectedSize;
}

/** Kept for API compatibility with callers that imported the old range size. */
export const DOWNLOAD_RANGE_CHUNK_BYTES = 8 * 1024 ** 2;

async function downloadResponseError(response: Response): Promise<Error> {
  if (response.status === 403) {
    const body = await response.clone().text().catch(() => "");
    if (/error\s*1015|being rate limited/i.test(body)) {
      const headers = new Headers();
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) headers.set("retry-after", retryAfter);
      return httpErrorFromResponse(new Response(null, { status: 429, headers }));
    }
  }
  return httpErrorFromResponse(response);
}

export async function downloadUrlToFileInSingleRequest(
  url: string,
  path: string,
  config: Pick<Config, "requestTimeoutMs" | "maxRetries" | "proxyUrl">,
  expectedSize?: number,
): Promise<number> {
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error(`预期下载大小无效：${expectedSize}`);
  }
  const file = await open(path, "wx", 0o600);
  let lastError: unknown;
  try {
    // The website downloader makes one request per file. Do not replay a media
    // request from the CLI, because a retry is another rate-limit signal.
    {
      const controller = new AbortController();
      let response: Response | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let connectionTimedOut = false;
      try {
        timer = setTimeout(() => {
          connectionTimedOut = true;
          controller.abort();
        }, config.requestTimeoutMs);
        response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Referer: "https://www.asmr.one/",
            Origin: "https://www.asmr.one",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
          },
          signal: controller.signal,
          ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
        });
        clearTimeout(timer);
        timer = undefined;
        if (!response.ok) throw await downloadResponseError(response);
        if (response.status !== 200) throw new Error(`partial media response: HTTP ${response.status}; 分段响应范围不符`);

        const lengthHeader = response.headers.has("content-encoding")
          ? null
          : response.headers.get("content-length");
        const responseSize = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
        if (responseSize !== undefined && (!Number.isSafeInteger(responseSize) || responseSize < 0)) {
          throw new Error(`响应文件大小无效：${lengthHeader}`);
        }
        if (expectedSize !== undefined && responseSize !== undefined && responseSize !== expectedSize) {
          throw new Error(`响应文件大小不符：预期 ${expectedSize}，响应声明 ${responseSize}`);
        }
        const received = await writeResponseBodyToHandle(
          response,
          file,
          controller,
          config.requestTimeoutMs,
          0,
          expectedSize ?? responseSize,
        );
        const completeSize = expectedSize ?? responseSize;
        if (completeSize !== undefined && received !== completeSize) {
          throw new Error(`下载响应提前结束：预期 ${completeSize}，实际 ${received}`);
        }
        return received;
      } catch (error) {
        const requestError = connectionTimedOut
          ? new Error(`下载连接超过 ${config.requestTimeoutMs} 毫秒未响应：${url}`)
          : error;
        lastError = requestError;
        await file.truncate(0);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      }
    }
    throw new Error(`下载文件失败：${errorMessage(lastError)}`, { cause: lastError });
  } finally {
    await file.close();
  }
}

class TrackListUnavailableError extends Error {
  constructor(workId: number, cause: unknown) {
    super(`站点暂无可下载资源（作品 ${workId} 没有文件列表）`, { cause });
    this.name = "TrackListUnavailableError";
  }
}

export type ContentRange = { start: number; end: number; total?: number };

export function parseContentRange(value: string | null): ContentRange | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    (total !== undefined && (!Number.isSafeInteger(total) || total <= end))
  ) return undefined;
  return { start, end, ...(total !== undefined ? { total } : {}) };
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

async function writeResponseBodyToHandle(
  response: Response,
  file: FileHandle,
  controller: AbortController,
  inactivityTimeoutMs: number,
  startPosition: number,
  expectedSize?: number,
): Promise<number> {
  if (!response.body) throw new Error("下载响应没有文件内容");
  if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new Error(`下载无数据超时必须是正数，实际为 ${inactivityTimeoutMs}`);
  }
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error(`预期下载大小无效：${expectedSize}`);
  }
  if (!Number.isSafeInteger(startPosition) || startPosition < 0) {
    throw new Error(`下载写入位置无效：${startPosition}`);
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let position = startPosition;
  let received = 0;
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
      if (!Number.isSafeInteger(position + chunk.value.byteLength) || !Number.isSafeInteger(received + chunk.value.byteLength)) {
        controller.abort();
        throw new Error("下载文件大小超过安全整数范围");
      }
      if (expectedSize !== undefined && received + chunk.value.byteLength > expectedSize) {
        controller.abort();
        throw new Error(`下载数据超过预期大小 ${expectedSize}`);
      }
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset, position);
        if (written.bytesWritten <= 0) throw new Error("无法继续写入下载文件");
        offset += written.bytesWritten;
        position += written.bytesWritten;
        received += written.bytesWritten;
      }
    }
  } finally {
    if (reader) {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return received;
}

export async function writeResponseBodyToFile(
  response: Response,
  path: string,
  controller: AbortController,
  inactivityTimeoutMs: number,
  expectedSize?: number,
): Promise<void> {
  // Exclusive creation prevents a concurrently inserted symlink from being followed.
  const file = await open(path, "wx", 0o600);
  try {
    await writeResponseBodyToHandle(response, file, controller, inactivityTimeoutMs, 0, expectedSize);
  } finally {
    await file.close();
  }
}

export async function downloadUrlToFileInRanges(
  url: string,
  path: string,
  config: Pick<Config, "requestTimeoutMs" | "maxRetries" | "proxyUrl">,
  expectedSize?: number,
): Promise<number> {
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error(`预期下载大小无效：${expectedSize}`);
  }
  // Kept as a compatibility wrapper for the old exported name. The browser
  // flow always downloads each media file with one complete GET request.
  return downloadUrlToFileInSingleRequest(url, path, config, expectedSize);
  /* Legacy Range implementation intentionally disabled.
  const file = await open(path, "wx", 0o600);
  let position = 0;
  let totalSize = expectedSize;
  try {
    while (totalSize === undefined || position < totalSize) {
      const requestedEnd = Math.min(
        position + DOWNLOAD_RANGE_CHUNK_BYTES - 1,
        totalSize === undefined ? Number.MAX_SAFE_INTEGER : totalSize - 1,
      );
      let lastError: unknown;
      let rangeComplete = false;
      for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        const controller = new AbortController();
        let response: Response | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let connectionTimedOut = false;
        try {
          await waitForKikoMediaRequest(url);
          timer = setTimeout(() => {
            connectionTimedOut = true;
            controller.abort();
          }, config.requestTimeoutMs);
          response = await fetch(url, {
            headers: {
              Range: `bytes=${position}-${requestedEnd}`,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              Accept: "* / *",
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
              Referer: "https://www.asmr.one/",
              Origin: "https://www.asmr.one",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "cross-site",
            },
            signal: controller.signal,
            ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
          });
          clearTimeout(timer);
          timer = undefined;
          if (!response.ok) throw await downloadResponseError(response);

          const lengthHeader = response.headers.has("content-encoding")
            ? null
            : response.headers.get("content-length");
          const responseSize = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
          if (responseSize !== undefined && (!Number.isSafeInteger(responseSize) || responseSize < 0)) {
            throw new Error(`响应文件大小无效：${lengthHeader}`);
          }

          if (response.status === 206) {
            if (response.headers.has("content-encoding")) {
              throw new Error("分段响应不应包含 Content-Encoding");
            }
            const contentRange = parseContentRange(response.headers.get("content-range"));
            if (!contentRange || contentRange.total === undefined) {
              throw new Error(`分段响应的 Content-Range 无效：${response.headers.get("content-range") ?? "缺失"}`);
            }
            if (contentRange.start !== position || contentRange.end > requestedEnd) {
              throw new Error(
                `分段响应范围不符：请求 ${position}-${requestedEnd}，响应 ${contentRange.start}-${contentRange.end}`,
              );
            }
            if (totalSize !== undefined && contentRange.total !== totalSize) {
              throw new Error(`响应文件大小不符：预期 ${totalSize}，响应声明 ${contentRange.total}`);
            }
            totalSize = contentRange.total;
            const expectedRangeSize = contentRange.end - contentRange.start + 1;
            if (responseSize !== undefined && responseSize !== expectedRangeSize) {
              throw new Error(`分段响应大小不符：范围 ${expectedRangeSize}，响应声明 ${responseSize}`);
            }
            const received = await writeResponseBodyToHandle(
              response,
              file,
              controller,
              config.requestTimeoutMs,
              position,
              expectedRangeSize,
            );
            if (received !== expectedRangeSize) {
              throw new Error(`分段响应提前结束：预期 ${expectedRangeSize}，实际 ${received}`);
            }
            position += received;
          } else if (response.status === 200 && position === 0) {
            if (totalSize !== undefined && responseSize !== undefined && responseSize !== totalSize) {
              throw new Error(`响应文件大小不符：预期 ${totalSize}，响应声明 ${responseSize}`);
            }
            const fullSize = totalSize ?? responseSize;
            const received = await writeResponseBodyToHandle(
              response,
              file,
              controller,
              config.requestTimeoutMs,
              0,
              fullSize,
            );
            if (fullSize !== undefined && received !== fullSize) {
              throw new Error(`响应提前结束：预期 ${fullSize}，实际 ${received}`);
            }
            position = received;
            totalSize = received;
          } else {
            throw new Error(`资源服务器没有按请求返回分段数据：HTTP ${response.status}`);
          }
          rangeComplete = true;
          break;
        } catch (error) {
          const requestError = connectionTimedOut
            ? new Error(`下载连接超过 ${config.requestTimeoutMs} 毫秒未响应：${url}`)
            : error;
          lastError = requestError;
          await file.truncate(position);
          if (attempt < config.maxRetries && isRetryableRequestError(requestError)) {
            const delayMs = retryDelayMilliseconds(requestError, attempt + 1, 60_000);
            logger.warn(
              `下载分段失败（${attempt + 1}/${config.maxRetries + 1}，字节 ${position}-${requestedEnd}）：` +
              `${errorMessage(requestError)}；${delayMs} 毫秒后重试`,
            );
            await Bun.sleep(delayMs);
          } else if (!isRetryableRequestError(requestError)) {
            break;
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
        }
      }
      if (!rangeComplete) throw new Error(`下载分段 ${position}-${requestedEnd} 失败：${errorMessage(lastError)}`, { cause: lastError });
    }
    return position;
  } finally {
    await file.close();
  }
  */
}

const downloadFile = async (file: DownloadFile, root: string, config: Config): Promise<"downloaded" | "skipped"> => {
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
  try {
    await rm(partialPath, { force: true });
    const downloadedSize = await downloadUrlToFileInSingleRequest(file.url, partialPath, config, file.size);
    if (file.size !== undefined && downloadedSize !== file.size) {
      throw new Error(`文件大小不符：预期 ${file.size}，实际 ${downloadedSize}`);
    }
    const actualSize = (await stat(partialPath)).size;
    if (actualSize !== downloadedSize) {
      throw new Error(`文件写入大小不符：下载 ${downloadedSize}，磁盘文件 ${actualSize}`);
    }
    await rm(targetPath, { force: true });
    await rename(partialPath, targetPath);
    return "downloaded";
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw new Error(`${file.relativePath}：${errorMessage(error)}`, { cause: error });
  }
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
): Promise<void> => {
  let trackTree: TrackNode[];
  try {
    trackTree = await fetchJson<TrackNode[]>(`${API_BASE_URL}/api/tracks/${workId}?v=2`, config);
  } catch (error) {
    if (findHttpResponseError(error)?.status === 404) {
      throw new TrackListUnavailableError(workId, error);
    }
    throw error;
  }
  if (!Array.isArray(trackTree)) throw new Error("文件列表 API 返回了无法识别的数据结构");
  const files = buildDownloadFilePlan(trackTree);
  if (files.length === 0) throw new Error("网站文件列表为空，无法下载");
  // The website downloads a work's files in list order, one complete request
  // at a time. Keep the same request shape for every media host.
  const workerCount = 1;
  logger.info(`内置下载器：全部 ${files.length} 个资源，并发 ${workerCount}（完整文件单请求，按顺序下载）`);
  let processed = 0;
  let reused = 0;
  await mapLimit(files, workerCount, async (file) => {
    try {
      const status = await downloadFile(file, stagingPath, config);
      if (status === "skipped") reused += 1;
      processed += 1;
      logger.info(`[${processed}/${files.length}] ${status === "skipped" ? "已下载" : "完成"} ${file.relativePath}`);
      return undefined;
    } catch (error) {
      // Match the website: the work stops as soon as one file fails.
      throw error;
    }
  });
  if (reused > 0) logger.info(`复用了 ${reused} 个已下载文件`);
};

const downloadWork = async (
  target: DownloadTarget,
  config: Config,
): Promise<DownloadResult> => {
  const { workId, displayId } = target;
  const targetPath = join(
    config.downloadDir,
    ...(target.author ? [sanitizeDownloadPathSegment(target.author)] : []),
    displayId,
  );
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
  const authorSegment = target.author ? sanitizeDownloadPathSegment(target.author) : undefined;
  const stagingAuthorRoot = authorSegment ? join(stagingRoot, authorSegment) : stagingRoot;
  let stagingPath = join(stagingAuthorRoot, displayId);
  try {
    await mkdir(stagingRoot, { recursive: true });
    const stagingRootInfo = await lstat(stagingRoot);
    if (stagingRootInfo.isSymbolicLink() || !stagingRootInfo.isDirectory()) {
      throw new Error(`下载临时根路径不是普通文件夹：${stagingRoot}`);
    }
    await mkdir(stagingAuthorRoot, { recursive: true });
    stagingPath = await prepareStagingPath(stagingAuthorRoot, displayId);
    logger.info(`下载完整作品 ${displayId} ...`);
    await downloadWithBuiltin(workId, stagingPath, config);
    if (await pathExists(targetPath)) throw new Error(`目标文件夹已存在：${targetPath}`);
    const size = await directorySize(stagingPath);
    await ensureSafeDownloadDirectory(config.downloadDir, dirname(targetPath));
    await rename(stagingPath, targetPath);
    return { workId, displayId, status: "downloaded", targetPath, size };
  } catch (error) {
    const responseError = findHttpResponseError(error);
    const retryAfterMinutes = responseError?.retryAfterTotalMs === undefined
      ? undefined
      : Math.round(responseError.retryAfterTotalMs / 60_000 * 100) / 100;
    if (retryAfterMinutes !== undefined) {
      logger.warn(`作品 ${displayId} 受到限流，约 ${retryAfterMinutes} 分钟后重试${responseError?.retryAfterAt ? `（${responseError.retryAfterAt}）` : ""}`);
    }
    if (error instanceof TrackListUnavailableError) {
      return { workId, displayId, status: "unavailable", stagingPath, error: error.message };
    }
    if (findHttpResponseError(error)?.status === 503) {
      throw new Error(`作品 ${displayId}：${errorMessage(error)}`, { cause: error });
    }
    const rateLimited = responseError?.status === 429;
    return {
      workId,
      displayId,
      status: "failed",
      stagingPath,
      error: errorMessage(error),
      ...(rateLimited ? { rateLimited: true } : {}),
      ...(retryAfterMinutes !== undefined ? { retryAfterMinutes } : {}),
      ...(responseError?.retryAfterAt ? { retryAfterAt: responseError.retryAfterAt } : {}),
    };
  }
};

type NumericDownloadOne = (workId: number, config: Config) => Promise<DownloadResult>;
type TargetDownloadOne = (target: DownloadTarget, config: Config) => Promise<DownloadResult>;

export function downloadWorks(workIds: number[], config: Config, downloadOne?: NumericDownloadOne): Promise<DownloadBatchResult>;
export function downloadWorks(targets: DownloadTarget[], config: Config, downloadOne?: TargetDownloadOne): Promise<DownloadBatchResult>;
export function downloadWorks(targets: DownloadTarget[], config: Config, downloadOne: TargetDownloadOne | undefined, options?: { retryFailedWorks?: boolean }): Promise<DownloadBatchResult>;
export async function downloadWorks(
  inputs: Array<number | DownloadTarget>,
  config: Config,
  downloadOne?: NumericDownloadOne | TargetDownloadOne,
  options: { retryFailedWorks?: boolean } = {},
): Promise<DownloadBatchResult> {
  const entries = [...new Map(inputs.map((input) => {
    const target = typeof input === "number" ? { workId: input, displayId: formatWorkId(input) } : input;
    return [`${target.author ?? ""}\0${target.workId}\0${target.displayId}`, { input, target }] as const;
  })).values()];
  const run = (entry: typeof entries[number]): Promise<DownloadResult> => {
    if (!downloadOne) return downloadWork(entry.target, config);
    return typeof entry.input === "number"
      ? (downloadOne as NumericDownloadOne)(entry.input, config)
      : (downloadOne as TargetDownloadOne)(entry.input, config);
  };
  const runSafely = async (entry: typeof entries[number]): Promise<{
    result: DownloadResult;
    serviceUnavailable: boolean;
    rateLimited: boolean;
  }> => {
    try {
      const result = await run(entry);
      return { result, serviceUnavailable: false, rateLimited: result.rateLimited === true };
    } catch (error) {
      const responseError = findHttpResponseError(error);
      const retryAfterMinutes = responseError?.retryAfterTotalMs === undefined
        ? undefined
        : Math.round(responseError.retryAfterTotalMs / 60_000 * 100) / 100;
      return {
        result: {
          ...entry.target,
          status: "failed",
          error: errorMessage(error),
          ...(retryAfterMinutes !== undefined ? { retryAfterMinutes } : {}),
          ...(responseError?.retryAfterAt ? { retryAfterAt: responseError.retryAfterAt } : {}),
        },
        serviceUnavailable: findHttpResponseError(error)?.status === 503,
        rateLimited: findHttpResponseError(error)?.status === 429,
      };
    }
  };
  const results: DownloadResult[] = [];
  let downloadedSize = 0;
  let stoppedByLimit = false;
  let stoppedByServiceUnavailable = false;
  let stoppedByRateLimit = false;
  let attemptedCount = 0;
  let pendingRetryCount = 0;
  for (const [index, entry] of entries.entries()) {
    logger.info(`[作品 ${index + 1}/${entries.length}] ${entry.target.displayId}`);
    const outcome = await runSafely(entry);
    const result = outcome.result;
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
    else if (result.status === "unavailable") logger.warn(`站点暂无资源，跳过：${result.displayId}：${result.error}`);
    else {
      logger.error(`作品失败：${result.displayId}：${result.error}`);
      if (result.retryAfterMinutes !== undefined) {
        logger.warn(`作品 ${result.displayId} 约 ${result.retryAfterMinutes} 分钟后可重试${result.retryAfterAt ? `（${result.retryAfterAt}）` : ""}`);
      }
      if (outcome.serviceUnavailable) {
        stoppedByServiceUnavailable = true;
        logger.warn("资源服务器持续返回 HTTP 503，已停止本轮下载；临时文件已保留，稍后重新运行可继续下载。");
        break;
      }
      if (outcome.rateLimited) {
        stoppedByRateLimit = true;
        logger.warn("媒体服务器返回 HTTP 429/Cloudflare 1015，已暂停本轮下载；请等待限流窗口结束后再运行。");
        break;
      }
    }
  }
  const failedIndexes = results.flatMap((result, index) => result.status === "failed" ? [index] : []);
  if (options.retryFailedWorks !== false && !stoppedByLimit && !stoppedByServiceUnavailable && !stoppedByRateLimit && failedIndexes.length > 0) {
    logger.warn(`首轮有 ${failedIndexes.length} 部作品失败，开始续传重试。`);
    for (const [retryIndex, resultIndex] of failedIndexes.entries()) {
      const entry = entries[resultIndex];
      logger.info(`[重试 ${retryIndex + 1}/${failedIndexes.length}] ${entry.target.displayId}`);
      const outcome = await runSafely(entry);
      const result = outcome.result;
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
      } else if (result.status === "unavailable") {
        logger.warn(`站点暂无资源，跳过：${result.displayId}：${result.error}`);
      } else {
        logger.error(`重试失败：${result.displayId}：${result.error}`);
        if (outcome.serviceUnavailable) {
          stoppedByServiceUnavailable = true;
          pendingRetryCount = failedIndexes.length - retryIndex - 1;
          logger.warn("资源服务器持续返回 HTTP 503，已停止本轮下载；临时文件已保留，稍后重新运行可继续下载。");
          break;
        }
        if (outcome.rateLimited) {
          stoppedByRateLimit = true;
          pendingRetryCount = failedIndexes.length - retryIndex - 1;
          logger.warn("媒体服务器返回 HTTP 429/Cloudflare 1015，已暂停本轮下载；请等待限流窗口结束后再运行。");
          break;
        }
      }
    }
  }
  const unattemptedCount = entries.length - attemptedCount;
  return {
    results,
    downloadedSize,
    stoppedByLimit,
    stoppedByServiceUnavailable,
    stoppedByRateLimit,
    remainingCount: unattemptedCount + pendingRetryCount,
  };
}

export async function resolveDownloadTargets(
  workCodes: Array<number | string>,
  config: Config,
  throttle?: RequestThrottle,
  author?: string,
): Promise<DownloadTarget[]> {
  const targetAuthor = (author ?? config.author).trim() || undefined;
  return mapLimit(workCodes, config.concurrency, async (input) => {
    const workCode = typeof input === "number" ? formatWorkId(input) : input;
    if (workCode.startsWith("RJ")) {
      return {
        workId: Number(workCode.slice(2)),
        displayId: workCode,
        ...(targetAuthor ? { author: targetAuthor } : {}),
      };
    }
    const work = await fetchWorkByCode(workCode, config, throttle);
    return {
      workId: work.id,
      displayId: workCodeFromSearchWork(work),
      ...(targetAuthor ? { author: targetAuthor } : {}),
    };
  }).then((targets) => [...new Map(targets.map((target) => [target.displayId, target])).values()]);
}
