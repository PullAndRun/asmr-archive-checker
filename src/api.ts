import { API_BASE_URL, SEARCH_PAGE_SIZE } from "./constants.ts";
import { formatWorkId, normalizeWorkCode, workCodeFromMetadata, type WorkCode } from "./domain/work-code.ts";
import { httpErrorFromResponse, isRetryableRequestError, retryDelayMilliseconds } from "./http.ts";
import { errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type { Config, RequestThrottle, SearchResponse, SearchWork } from "./types.ts";

export function buildSearchUrl(author: string, page: number, pageSize = SEARCH_PAGE_SIZE): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error(`搜索页码必须是正整数，实际为 ${page}`);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error(`每页数量必须是正整数，实际为 ${pageSize}`);
  const url = new URL(`/api/search/${encodeURIComponent(author)}`, API_BASE_URL);
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
  config: Pick<Config, "requestTimeoutMs" | "maxRetries" | "proxyUrl">,
  throttle?: RequestThrottle,
): Promise<T> {
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new Error(`请求超时必须是正数，实际为 ${config.requestTimeoutMs}`);
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 20) {
    throw new Error(`最大重试次数必须是 0 到 20 之间的整数，实际为 ${config.maxRetries}`);
  }
  const attempts = config.maxRetries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (throttle) await throttle();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "asmr-archive-checker/1.0" },
        signal: controller.signal,
        ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
      });
      if (!response.ok) throw httpErrorFromResponse(response);
      return (await response.json()) as T;
    } catch (error) {
      const requestError = timedOut ? new Error(`请求超过 ${config.requestTimeoutMs} 毫秒未完成`) : error;
      lastError = requestError;
      clearTimeout(timer);
      controller.abort();
      if (attempt < attempts && isRetryableRequestError(requestError)) {
        const delayMs = retryDelayMilliseconds(requestError, attempt);
        logger.warn(`API 请求失败（${attempt}/${attempts}）：${errorMessage(requestError)}；${delayMs} 毫秒后重试`);
        await Bun.sleep(delayMs);
      } else if (!isRetryableRequestError(requestError)) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`请求失败 ${url}：${errorMessage(lastError)}`);
}

export function validateSearchResponse(value: unknown): asserts value is SearchResponse {
  const record = typeof value === "object" && value !== null ? value as Partial<SearchResponse> : undefined;
  const pagination = record?.pagination;
  if (
    !record ||
    !Array.isArray(record.works) ||
    !pagination ||
    !Number.isSafeInteger(pagination.currentPage) ||
    pagination.currentPage < 1 ||
    !Number.isSafeInteger(pagination.pageSize) ||
    pagination.pageSize < 1 ||
    !Number.isSafeInteger(pagination.totalCount) ||
    pagination.totalCount < 0
  ) {
    throw new Error("作品列表 API 返回了无法识别的数据结构");
  }
  for (const work of record.works) {
    if (
      typeof work !== "object" ||
      work === null ||
      !Number.isSafeInteger(work.id) ||
      work.id < 1 ||
      (work.source_id !== undefined && typeof work.source_id !== "string")
    ) {
      throw new Error("作品列表 API 返回了无效的作品记录");
    }
  }
}

export async function fetchAllWorks(
  config: Config,
  throttle?: RequestThrottle,
): Promise<SearchWork[]> {
  logger.info(`正在读取作者作品列表${config.proxyUrl ? "（使用代理）" : ""}...`);
  const first = await fetchJson<SearchResponse>(buildSearchUrl(config.author, 1), config, throttle);
  validateSearchResponse(first);
  if (first.pagination.currentPage !== 1) {
    throw new Error(`作品列表 API 返回了错误页码：请求 1，返回 ${first.pagination.currentPage}`);
  }
  const totalPages = Math.max(1, Math.ceil(first.pagination.totalCount / first.pagination.pageSize));
  if (totalPages > 100_000) throw new Error(`作品列表 API 返回的分页数量异常：${totalPages}`);
  const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const responses = await mapLimit(pages, config.concurrency, async (page) => {
    logger.info(`正在读取作者作品列表：${page}/${totalPages}`);
    const response = await fetchJson<SearchResponse>(buildSearchUrl(config.author, page), config, throttle);
    validateSearchResponse(response);
    if (response.pagination.currentPage !== page) {
      throw new Error(`作品列表 API 返回了错误页码：请求 ${page}，返回 ${response.pagination.currentPage}`);
    }
    return response.works;
  });
  return [...new Map([first.works, ...responses].flat()
    .map((work) => [work.id, work])).values()]
    .toSorted((left, right) => right.id - left.id);
}

export async function fetchWorkByCode(
  workCode: string,
  config: Config,
  throttle?: RequestThrottle,
): Promise<SearchWork> {
  const response = await fetchJson<SearchResponse>(buildWorkSearchUrl(workCode), config, throttle);
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
