import { API_BASE_URL, SEARCH_PAGE_SIZE } from "./constants.ts";
import { formatWorkId, normalizeWorkCode, workCodeFromMetadata, type WorkCode } from "./domain/work-code.ts";
import { errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type { Config, RequestThrottle, SearchResponse, SearchWork } from "./types.ts";

type HttpError = Error & { status: number };

const httpError = (status: number, statusText: string): HttpError =>
  Object.assign(new Error(`HTTP ${status} ${statusText}`), { status });

const isHttpError = (error: unknown): error is HttpError =>
  error instanceof Error && "status" in error && typeof error.status === "number";

const isRetryable = (error: unknown): boolean =>
  !isHttpError(error) || error.status === 408 || error.status === 429 || error.status >= 500;

export function buildSearchUrl(author: string, page: number, pageSize = SEARCH_PAGE_SIZE): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error(`搜索页码必须是正整数，实际为 ${page}`);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error(`每页数量必须是正整数，实际为 ${pageSize}`);
  const expression = ` $va:${author}$`;
  const url = new URL(`/api/search/${encodeURIComponent(expression)}`, API_BASE_URL);
  url.searchParams.set("order", "create_date");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("subtitle", "0");
  url.searchParams.set("includeTranslationWorks", "true");
  return url.toString();
}

export function workCodeFromSearchWork(work: SearchWork): WorkCode {
  return workCodeFromMetadata(work);
}

export function buildWorkSearchUrl(id: number | string): string {
  const workCode = typeof id === "number" ? formatWorkId(id) : normalizeWorkCode(id);
  if (!workCode) throw new Error(`无法识别作品编号：${id}`);
  const url = new URL(`/api/search/${workCode}`, API_BASE_URL);
  url.searchParams.set("order", "create_date");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("subtitle", "0");
  url.searchParams.set("includeTranslationWorks", "true");
  return url.toString();
}

export async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  attempts = 4,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`请求超时必须是正数，实际为 ${timeoutMs}`);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`请求次数必须是正整数，实际为 ${attempts}`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (throttle) await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "asmr-archive-checker/1.0" },
        signal: controller.signal,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      });
      if (!response.ok) throw httpError(response.status, response.statusText);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts && isRetryable(error)) {
        const delayMs = Math.min(500 * 2 ** (attempt - 1), 8_000);
        logger.warn(`API 请求失败（${attempt}/${attempts}）：${errorMessage(error)}；${delayMs} 毫秒后重试`);
        await Bun.sleep(delayMs);
      } else if (!isRetryable(error)) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`请求失败 ${url}：${errorMessage(lastError)}`);
}

const validateSearchResponse = (value: SearchResponse): void => {
  const pagination = value?.pagination;
  if (
    !value ||
    !Array.isArray(value.works) ||
    !Number.isSafeInteger(pagination?.currentPage) ||
    pagination.currentPage < 1 ||
    !Number.isSafeInteger(pagination.pageSize) ||
    pagination.pageSize < 1 ||
    !Number.isSafeInteger(pagination.totalCount) ||
    pagination.totalCount < 0
  ) {
    throw new Error("作品列表 API 返回了无法识别的数据结构");
  }
};

export async function fetchAllWorks(
  config: Config,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<SearchWork[]> {
  logger.info(`正在读取作者作品列表${proxyUrl ? "（使用代理）" : ""}...`);
  const first = await fetchJson<SearchResponse>(buildSearchUrl(config.author, 1), config.requestTimeoutMs, 4, proxyUrl, throttle);
  validateSearchResponse(first);
  const totalPages = Math.max(1, Math.ceil(first.pagination.totalCount / first.pagination.pageSize));
  if (totalPages > 100_000) throw new Error(`作品列表 API 返回的分页数量异常：${totalPages}`);
  const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const responses = await mapLimit(pages, config.concurrency, async (page) => {
    logger.info(`正在读取作者作品列表：${page}/${totalPages}`);
    const response = await fetchJson<SearchResponse>(buildSearchUrl(config.author, page), config.requestTimeoutMs, 4, proxyUrl, throttle);
    validateSearchResponse(response);
    return response.works;
  });
  return [...new Map([first.works, ...responses].flat()
    .filter((work) => Number.isInteger(work.id))
    .map((work) => [work.id, work])).values()]
    .toSorted((left, right) => right.id - left.id);
}

export async function fetchWorkByCode(
  workCode: string,
  config: Config,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<SearchWork> {
  const response = await fetchJson<SearchResponse>(buildWorkSearchUrl(workCode), config.requestTimeoutMs, 4, proxyUrl, throttle);
  validateSearchResponse(response);
  const normalizedCode = normalizeWorkCode(workCode);
  const work = response.works.find((candidate) => workCodeFromSearchWork(candidate) === normalizedCode);
  if (!work) throw new Error(`搜索 ${workCode} 时没有找到精确匹配的作品`);
  return work;
}

export function createRequestThrottle(requestsPerSecond: number): RequestThrottle {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
    throw new Error(`API 请求速率必须是正数，实际为 ${requestsPerSecond}`);
  }
  const intervalMs = 1_000 / requestsPerSecond;
  let nextRequestAt = 0;
  let queue = Promise.resolve();
  return () => {
    const task = queue.then(async () => {
      const delayMs = Math.max(0, nextRequestAt - performance.now());
      if (delayMs > 0) await Bun.sleep(delayMs);
      nextRequestAt = performance.now() + intervalMs;
    });
    queue = task.catch(() => undefined);
    return task;
  };
}
