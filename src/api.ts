import { API_BASE_URL, SEARCH_PAGE_SIZE } from "./constants.ts";
import { formatWorkId, normalizeWorkCode, workCodeFromMetadata, type WorkCode } from "./domain/work-code.ts";
import { httpErrorFromResponse, isRetryableRequestError, retryDelayMilliseconds } from "./http.ts";
import { errorMessage, mapLimit } from "./shared.ts";
import { logger } from "./logger.ts";
import type { Config, RequestThrottle, SearchResponse, SearchWork } from "./types.ts";

export type AuthorSearchField = "circle" | "va";

export function buildAuthorSearchKeywords(author: string): string[] {
  const name = author.trim();
  if (!name) throw new Error("作者名不能为空");
  return (["circle", "va"] satisfies AuthorSearchField[])
    .map((field) => `$${field}:${name}$`);
}

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

function resolveApiRequestUrls(url: string, apiUrls?: readonly string[]): string[] {
  if (!apiUrls || apiUrls.length === 0) return [url];
  let original: URL;
  try {
    original = new URL(url);
  } catch {
    return [url];
  }
  if (original.origin !== new URL(API_BASE_URL).origin) return [url];
  const orderedApiUrls = apiUrlOrder.get(apiUrls) ?? apiUrls;
  return orderedApiUrls.map((base) => {
    const endpoint = new URL(base);
    endpoint.pathname = original.pathname;
    endpoint.search = original.search;
    return endpoint.toString();
  });
}

const apiUrlOrder = new WeakMap<readonly string[], string[]>();

export function promoteApiUrl(apiUrls: readonly string[], successfulOrigin: string): void {
  const currentUrls = apiUrlOrder.get(apiUrls) ?? [...apiUrls];
  const promoted = [successfulOrigin, ...currentUrls.filter((value) => value !== successfulOrigin)];
  apiUrlOrder.set(apiUrls, promoted);
  // Preserve the observable config order when callers provide a mutable array.
  if (Array.isArray(apiUrls) && !Object.isFrozen(apiUrls)) {
    const mutable = apiUrls as string[];
    mutable.splice(0, mutable.length, ...promoted);
  }
}

/** Replace only the origin of a media URL, retaining its path and query. */
export function replaceUrlOrigin(url: string, origin: string): string {
  const parsed = new URL(url);
  const replacement = new URL(origin);
  parsed.protocol = replacement.protocol;
  parsed.hostname = replacement.hostname;
  parsed.port = replacement.port;
  parsed.username = replacement.username;
  parsed.password = replacement.password;
  return parsed.toString();
}

const SPEED_TEST_BYTES = 256 * 1024;

type SpeedTestConfig = Pick<Config, "requestTimeoutMs" | "proxyUrl"> & { apiUrls?: readonly string[] };

async function measureUrlSpeed(url: string, config: SpeedTestConfig): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = performance.now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "*/*",
        "User-Agent": "asmr-archive-checker/1.0",
      },
      signal: controller.signal,
      ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
    });
    if (!response.ok) throw httpErrorFromResponse(response);
    if (!response.body) throw new Error("测速响应没有文件内容");
    reader = response.body.getReader();
    let bytes = 0;
    while (bytes < SPEED_TEST_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
    }
    if (bytes <= 0) throw new Error("测速响应没有返回文件数据");
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1_000, 0.001);
    return bytes / elapsedSeconds;
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Probe the first media URL through every configured API origin and promote
 * the fastest working origin for the rest of the current download.
 */
export async function selectFastestApiUrl(
  mediaUrl: string,
  config: SpeedTestConfig,
): Promise<string | undefined> {
  const apiUrls = config.apiUrls;
  if (!apiUrls || apiUrls.length === 0) return undefined;
  const candidates = [...new Set(apiUrls)];
  if (candidates.length === 1) return candidates[0];
  const measured = await Promise.all(candidates.map(async (origin) => {
    try {
      const speed = await measureUrlSpeed(replaceUrlOrigin(mediaUrl, origin), config);
      return { origin, speed };
    } catch (error) {
      logger.warn(`API endpoint speed test failed: ${origin}; ${errorMessage(error)}`);
      return undefined;
    }
  }));
  const fastest = measured
    .filter((result): result is { origin: string; speed: number } => result !== undefined)
    .toSorted((left, right) => right.speed - left.speed)[0];
  if (!fastest) return undefined;
  promoteApiUrl(apiUrls, fastest.origin);
  logger.info(`Media download endpoint selected: ${fastest.origin} (${Math.round(fastest.speed / 1024)} KiB/s)`);
  return fastest.origin;
}

export async function fetchJson<T>(
  url: string,
  config: Pick<Config, "requestTimeoutMs" | "maxRetries" | "proxyUrl"> & { apiUrls?: readonly string[] },
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
  const requestUrls = resolveApiRequestUrls(url, config.apiUrls);
  let lastRequestUrl = url;
  for (const [endpointIndex, requestUrl] of requestUrls.entries()) {
    lastRequestUrl = requestUrl;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (throttle) await throttle();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.requestTimeoutMs);
    try {
      const response = await fetch(requestUrl, {
        headers: { Accept: "application/json", "User-Agent": "asmr-archive-checker/1.0" },
        signal: controller.signal,
        ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
      });
      if (!response.ok) throw httpErrorFromResponse(response);
      const result = (await response.json()) as T;
      // Keep a successful failover endpoint first for subsequent requests in
      // this run. Each call still uses its own URL snapshot, so in-flight
      // concurrent requests are unaffected by this update.
      if (endpointIndex > 0 && config.apiUrls && requestUrls.length > 1) {
        const successfulOrigin = new URL(requestUrl).origin;
        promoteApiUrl(config.apiUrls, successfulOrigin);
      }
      return result;
    } catch (error) {
      const requestError = timedOut ? new Error(`请求超过 ${config.requestTimeoutMs} 毫秒未完成`) : error;
      lastError = requestError;
      clearTimeout(timer);
      controller.abort();
      // With endpoint failover configured, rate limits and server-side failures
      // should move to the next API immediately instead of exhausting retries
      // against the same endpoint.
      if (requestUrls.length > 1 && isRetryableRequestError(requestError)) break;
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
    const nextRequestUrl = requestUrls[endpointIndex + 1];
    if (nextRequestUrl) {
      logger.warn(`API endpoint failed: ${requestUrl}; switching to ${nextRequestUrl}`);
    } else {
      logger.warn(`API endpoint failed: ${requestUrl}; no endpoint remains`);
    }
  }
  throw new Error(`请求失败 ${url}：${errorMessage(lastError)}`, { cause: lastError });
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

export async function fetchWorksForAuthor(
  author: string,
  config: Config,
  throttle?: RequestThrottle,
): Promise<SearchWork[]> {
  logger.info(`Reading author works: ${author}`);
  const searches = buildAuthorSearchKeywords(author);
  const works: SearchWork[] = [];
  for (const keyword of searches) {
    works.push(...await fetchWorksByKeyword(keyword, config, throttle, author));
  }
  return [...new Map(works.map((work) => [work.id, work])).values()]
    .toSorted((left, right) => right.id - left.id);
}

export async function fetchAllWorks(
  config: Config,
  throttle?: RequestThrottle,
): Promise<SearchWork[]> {
  logger.info(`正在读取作者作品列表${config.proxyUrl ? "（使用代理）" : ""}...`);
  const searches = buildAuthorSearchKeywords(config.author);
  const works: SearchWork[] = [];
  for (const keyword of searches) {
    works.push(...await fetchWorksByKeyword(keyword, config, throttle));
  }
  return [...new Map(works.map((work) => [work.id, work])).values()]
    .toSorted((left, right) => right.id - left.id);
}

async function fetchWorksByKeyword(
  keyword: string,
  config: Config,
  throttle?: RequestThrottle,
  authorLabel = keyword,
): Promise<SearchWork[]> {
  logger.info(`Fetching author page 1: ${authorLabel}`);
  const first = await fetchJson<SearchResponse>(buildSearchUrl(keyword, 1), config, throttle);
  validateSearchResponse(first);
  if (first.pagination.currentPage !== 1) {
    throw new Error(`作品列表 API 返回了错误页码：请求 1，返回 ${first.pagination.currentPage}`);
  }
  const totalPages = Math.max(1, Math.ceil(first.pagination.totalCount / first.pagination.pageSize));
  if (totalPages > 100_000) throw new Error(`作品列表 API 返回的分页数量异常：${totalPages}`);
  const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const responses = await mapLimit(pages, config.concurrency, async (page) => {
    logger.info(`正在读取作者作品列表：${page}/${totalPages}`);
    const response = await fetchJson<SearchResponse>(buildSearchUrl(keyword, page), config, throttle);
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
