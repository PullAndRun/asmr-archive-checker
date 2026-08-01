import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const API_BASE_URL = "https://api.asmr-200.com";
const SEARCH_PAGE_SIZE = 100;
const INCOMPLETE_FILE_NAME = "不完整的压缩包.txt";
const MISSING_FILE_NAME = "遗漏下载的音声.txt";
const DOWNLOAD_QUEUE_FILE_NAME = "待下载的音声.txt";
const DELETE_QUEUE_FILE_NAME = "待删除的不完整压缩包.txt";
const NON_AUTHOR_FILE_NAME = "非该作者的作品.txt";

export type Config = {
  author: string;
  archiveDir: string;
  downloadDir: string;
  outputDir: string;
  sevenZipPath: string;
  downloaderPath: string;
  concurrency: number;
  requestTimeoutMs: number;
  maxDownloadSize: string;
  maxDownloadSizeBytes?: number;
};

export type Mode = "author" | "archives" | "delete" | "delete-non-author" | "download";

type SearchWork = {
  id: number;
  title?: string;
  release?: string;
};

type SearchResponse = {
  works: SearchWork[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalCount: number;
  };
};

type TrackNode = {
  type?: string;
  title?: string;
  children?: TrackNode[];
  mediaDownloadUrl?: string;
  size?: number;
};

type DownloadFile = {
  url: string;
  relativePath: string;
  size?: number;
};

type DownloaderSettings = {
  maxRetries: number;
  maxWorkers: number;
  preferMedia: string;
  proxyUrl: string;
  requestTimeoutMs: number;
  syncQps: number;
};

type RequestThrottle = () => Promise<void>;

type ArchiveEntry = {
  path: string;
  attributes: string;
};

export type IncompleteArchive = {
  archivePath: string;
  workId: number;
  missingFiles: string[];
  error?: string;
};

export type NonAuthorWork = {
  path: string;
  workId: number;
  type: "压缩包" | "文件夹";
};

export type NonAuthorDeletionCandidate = NonAuthorWork & {
  size: number;
};

export type NonAuthorDeletionFailure = {
  path: string;
  error: string;
};

export type DeletionCandidate = {
  archivePath: string;
  workId: number;
  size: number;
};

export type DeletionFailure = {
  archivePath: string;
  error: string;
};

export type DownloadResult = {
  workId: number;
  displayId: string;
  status: "downloaded" | "skipped" | "failed";
  targetPath?: string;
  stagingPath?: string;
  size?: number;
  error?: string;
};

export type DownloadBatchResult = {
  results: DownloadResult[];
  downloadedSize: number;
  stoppedByLimit: boolean;
  remainingCount: number;
};

type CliOptions = {
  mode: Mode;
  configPath?: string;
  author?: string;
  archiveDir?: string;
  outputDir?: string;
  downloadDir?: string;
  sevenZipPath?: string;
  downloaderPath?: string;
  concurrency?: number;
  maxDownloadSize?: string;
  help: boolean;
};

const DEFAULT_CONFIG: Config = {
  author: "",
  archiveDir: ".",
  downloadDir: "",
  outputDir: "./output",
  sevenZipPath: "7z",
  downloaderPath: "asmroner",
  concurrency: 4,
  requestTimeoutMs: 30_000,
  maxDownloadSize: "",
};

function usage(): string {
  return `用法：bun run check -- <命令> [选项]

命令：
  author                按作者核对并汇总遗漏和不完整作品
  archives              检查目录内每一个 7z，汇总不完整作品
  delete                读取已有检查结果，确认后删除不完整作品
  delete-non-author     读取作者检查结果，确认后删除非该作者作品
  download              读取待下载汇总并下载完整作品

选项：
  --config <文件>       配置文件，默认 ./config.json
  --author <作者名>     临时覆盖作者名
  --dir <7z目录>        临时覆盖压缩包目录
  --output <输出目录>   临时覆盖输出目录
  --download-dir <目录> 下载完整作品的目录；download 模式必须指定
  --7z <程序路径>       7z 可执行程序，默认 7z
  --downloader <路径>   asmroner 可执行程序，默认 asmroner
  --concurrency <数量>  API 并发数，默认 4
  --max-download-size <体积>
                        本次下载体积上限，例如 100 GB；默认不限制
  -h, --help            显示帮助`;
}

export function parseArgs(args: string[]): CliOptions {
  const values = [...args];
  if (values[0] === "--") values.shift();
  let mode: Mode = "author";
  if (
    values[0] === "author" || values[0] === "archives" ||
    values[0] === "delete" || values[0] === "delete-non-author" ||
    values[0] === "download"
  ) {
    mode = values.shift() as Mode;
  }
  const result: CliOptions = { mode, help: false };
  const options: Record<string, keyof Omit<CliOptions, "help">> = {
    "--config": "configPath",
    "--author": "author",
    "--dir": "archiveDir",
    "--output": "outputDir",
    "--download-dir": "downloadDir",
    "--7z": "sevenZipPath",
    "--downloader": "downloaderPath",
    "--concurrency": "concurrency",
    "--max-download-size": "maxDownloadSize",
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "-h" || argument === "--help") {
      result.help = true;
      continue;
    }
    const key = options[argument];
    if (!key) throw new Error(`未知参数：${argument}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${argument} 缺少值`);
    }
    if (key === "concurrency") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
        throw new Error("--concurrency 必须是 1 到 20 之间的整数");
      }
      result.concurrency = parsed;
    } else {
      result[key] = value as never;
    }
    index += 1;
  }
  return result;
}

async function loadConfig(cli: CliOptions): Promise<Config> {
  const explicitConfig = cli.configPath !== undefined;
  const configPath = resolve(cli.configPath ?? "config.json");
  let fileConfig: Partial<Config> = {};

  try {
    fileConfig = await Bun.file(configPath).json();
  } catch (error) {
    if (explicitConfig || !(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw new Error(`无法读取配置文件 ${configPath}：${errorMessage(error)}`);
    }
  }

  const configBase = dirname(configPath);
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...(cli.author !== undefined ? { author: cli.author } : {}),
    ...(cli.archiveDir !== undefined ? { archiveDir: cli.archiveDir } : {}),
    ...(cli.outputDir !== undefined ? { outputDir: cli.outputDir } : {}),
    ...(cli.downloadDir !== undefined ? { downloadDir: cli.downloadDir } : {}),
    ...(cli.sevenZipPath !== undefined ? { sevenZipPath: cli.sevenZipPath } : {}),
    ...(cli.downloaderPath !== undefined ? { downloaderPath: cli.downloaderPath } : {}),
    ...(cli.concurrency !== undefined ? { concurrency: cli.concurrency } : {}),
    ...(cli.maxDownloadSize !== undefined ? { maxDownloadSize: cli.maxDownloadSize } : {}),
  };

  if (typeof merged.author !== "string") throw new Error("author 必须是字符串");
  if (cli.mode === "author" && !merged.author.trim()) {
    throw new Error("author 模式需要在 config.json 或 --author 中填写作者名");
  }
  if (typeof merged.archiveDir !== "string" || !merged.archiveDir.trim()) {
    throw new Error("archiveDir 必须是非空目录路径");
  }
  if (typeof merged.downloadDir !== "string") throw new Error("downloadDir 必须是目录路径或空字符串");
  if (cli.mode === "download" && !merged.downloadDir.trim()) {
    throw new Error("download 模式需要在 config.json 的 downloadDir 或 --download-dir 中指定保存位置");
  }
  if (typeof merged.outputDir !== "string" || !merged.outputDir.trim()) {
    throw new Error("outputDir 必须是非空目录路径");
  }
  if (typeof merged.sevenZipPath !== "string" || !merged.sevenZipPath.trim()) {
    throw new Error("sevenZipPath 必须是非空命令或路径");
  }
  if (typeof merged.downloaderPath !== "string" || !merged.downloaderPath.trim()) {
    throw new Error("downloaderPath 必须是非空命令或路径");
  }
  if (!Number.isInteger(merged.concurrency) || merged.concurrency < 1 || merged.concurrency > 20) {
    throw new Error("concurrency 必须是 1 到 20 之间的整数");
  }
  if (!Number.isFinite(merged.requestTimeoutMs) || merged.requestTimeoutMs < 1_000) {
    throw new Error("requestTimeoutMs 必须不少于 1000 毫秒");
  }
  if (typeof merged.maxDownloadSize !== "string") {
    throw new Error("maxDownloadSize 必须是带单位的体积字符串或空字符串");
  }

  merged.author = merged.author.trim();
  merged.archiveDir = resolvePath(configBase, merged.archiveDir);
  merged.downloadDir = merged.downloadDir.trim()
    ? resolvePath(configBase, merged.downloadDir)
    : "";
  merged.outputDir = resolvePath(configBase, merged.outputDir);
  merged.maxDownloadSize = merged.maxDownloadSize.trim();
  merged.maxDownloadSizeBytes = merged.maxDownloadSize
    ? parseFileSize(merged.maxDownloadSize)
    : undefined;
  if (looksLikePath(merged.sevenZipPath)) {
    merged.sevenZipPath = resolvePath(configBase, merged.sevenZipPath);
  }
  if (looksLikePath(merged.downloaderPath)) {
    merged.downloaderPath = resolvePath(configBase, merged.downloaderPath);
  }
  return merged;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function resolvePath(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function containsPath(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function prepareOutputDirectory(config: Config): Promise<void> {
  const outputDir = resolve(config.outputDir);
  const workingDirectory = resolve(".");
  if (dirname(outputDir) === outputDir) throw new Error("outputDir 不能是磁盘根目录");
  if (outputDir === workingDirectory || containsPath(outputDir, workingDirectory)) {
    throw new Error("outputDir 不能是项目目录或其上级目录");
  }
  if (containsPath(outputDir, config.archiveDir)) {
    throw new Error("outputDir 不能等于或包含 archiveDir");
  }
  if (config.downloadDir && containsPath(outputDir, config.downloadDir)) {
    throw new Error("outputDir 不能等于或包含 downloadDir");
  }
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("路径存在但不是文件夹");
  } catch (error) {
    throw new Error(`无法创建或使用 ${label}（${path}）：${errorMessage(error)}`);
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("路径存在但不是文件夹");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} 不存在：${path}，请指定已有的待扫描目录`);
    }
    throw new Error(`无法使用 ${label}（${path}）：${errorMessage(error)}`);
  }
}

export function buildSearchUrl(author: string, page: number, pageSize = SEARCH_PAGE_SIZE): string {
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

export function formatWorkId(id: number): string {
  const digits = String(id);
  const prefix = digits.length === 7 ? "0" : "";
  return `RJ${prefix}${digits}`;
}

export function buildWorkSearchUrl(id: number): string {
  const url = new URL(`/api/search/${formatWorkId(id)}`, API_BASE_URL);
  url.searchParams.set("order", "create_date");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("subtitle", "0");
  url.searchParams.set("includeTranslationWorks", "true");
  return url.toString();
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  attempts = 4,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<T> {
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
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 500 * 2 ** (attempt - 1);
        console.warn(
          `API 请求失败（${attempt}/${attempts}）：${errorMessage(error)}；${delayMs} 毫秒后重试`,
        );
        await Bun.sleep(delayMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`请求失败 ${url}：${errorMessage(lastError)}`);
}

async function fetchAllWorks(config: Config, proxyUrl = "", throttle?: RequestThrottle): Promise<SearchWork[]> {
  console.log(`正在读取作者作品列表${proxyUrl ? "（使用代理）" : ""}...`);
  const first = await fetchJson<SearchResponse>(
    buildSearchUrl(config.author, 1),
    config.requestTimeoutMs,
    4,
    proxyUrl,
    throttle,
  );
  validateSearchResponse(first);
  const totalPages = Math.max(1, Math.ceil(first.pagination.totalCount / first.pagination.pageSize));
  const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const responses = await mapLimit(remainingPages, config.concurrency, async (page) => {
    process.stdout.write(`\r正在读取作者作品列表：${page}/${totalPages}`);
    const response = await fetchJson<SearchResponse>(
      buildSearchUrl(config.author, page),
      config.requestTimeoutMs,
      4,
      proxyUrl,
      throttle,
    );
    validateSearchResponse(response);
    return response.works;
  });
  if (remainingPages.length > 0) process.stdout.write("\n");

  const unique = new Map<number, SearchWork>();
  for (const work of [first.works, ...responses].flat()) {
    if (Number.isInteger(work.id)) unique.set(work.id, work);
  }
  return [...unique.values()].sort((a, b) => b.id - a.id);
}

async function fetchWorkById(
  id: number,
  config: Config,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<SearchWork> {
  const response = await fetchJson<SearchResponse>(
    buildWorkSearchUrl(id),
    config.requestTimeoutMs,
    4,
    proxyUrl,
    throttle,
  );
  validateSearchResponse(response);
  const work = response.works.find((candidate) => candidate.id === id);
  if (!work) throw new Error(`搜索 ${formatWorkId(id)} 时没有找到精确匹配的作品`);
  return work;
}

function validateSearchResponse(value: SearchResponse): void {
  if (!value || !Array.isArray(value.works) || !Number.isFinite(value.pagination?.totalCount)) {
    throw new Error("作品列表 API 返回了无法识别的数据结构");
  }
}

async function findArchives(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".7z") found.push(resolve(path));
    }
  }
  await visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

async function findDownloadedWorkFolders(root: string): Promise<Array<{ path: string; workId: number }>> {
  const found: Array<{ path: string; workId: number }> = [];
  if (!(await pathExists(root))) return found;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".asmr-archive-checker-downloads") continue;
      const path = join(directory, entry.name);
      if (/^RJ\d+$/i.test(entry.name)) {
        const workId = workIdFromArchiveName(`${entry.name}.7z`);
        if (workId !== undefined) found.push({ path: resolve(path), workId });
      } else {
        await visit(path);
      }
    }
  }
  await visit(root);
  return found;
}

export function workIdFromArchiveName(path: string): number | undefined {
  const match = basename(path).match(/RJ(\d+)/i);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

async function listArchive(path: string, sevenZipPath: string): Promise<ArchiveEntry[]> {
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn([sevenZipPath, "l", "-slt", "-sccUTF-8", "--", path], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`无法启动 7-Zip（${sevenZipPath}）：${errorMessage(error)}`);
  }
  if (!(process.stdout instanceof ReadableStream) || !(process.stderr instanceof ReadableStream)) {
    throw new Error("7-Zip 子进程未提供可读的输出流");
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`7-Zip 返回代码 ${exitCode}：${stderr.trim() || stdout.trim()}`);
  }
  return parseSevenZipListing(stdout);
}

export function parseSevenZipListing(output: string): ArchiveEntry[] {
  const marker = /\r?\n-{10,}\r?\n/;
  const markerMatch = marker.exec(output);
  if (!markerMatch || markerMatch.index === undefined) {
    throw new Error("无法解析 7-Zip 文件清单");
  }
  const body = output.slice(markerMatch.index + markerMatch[0].length);
  const entries: ArchiveEntry[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let path: string | undefined;
    let attributes = "";
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(" = ");
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 3);
      if (key === "Path") path = value;
      else if (key === "Attributes") attributes = value;
    }
    if (path) entries.push({ path, attributes });
  }
  return entries;
}

export function flattenTrackTree(nodes: TrackNode[]): string[] {
  const paths: string[] = [];
  function visit(items: TrackNode[], parents: string[]): void {
    for (const item of items) {
      const title = typeof item.title === "string" ? item.title : "";
      const hasChildren = Array.isArray(item.children);
      if (hasChildren) {
        visit(item.children!, title ? [...parents, title] : parents);
      } else if (title && item.type !== "folder") {
        paths.push([...parents, title].join("/"));
      }
    }
  }
  visit(nodes, []);
  return paths;
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .normalize("NFC")
    .split("/")
    .map((part) => part.trimEnd())
    .join("/");
}

function comparisonKey(path: string): string {
  return normalizePath(path)
    .split("/")
    .map(sanitizeDownloadPathSegment)
    .join("/")
    .toLowerCase();
}

export function sanitizeDownloadPathSegment(value: string): string {
  let sanitized = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "_";

  const stem = sanitized.split(".", 1)[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) sanitized = `_${sanitized}`;

  const runes = [...sanitized];
  if (runes.length > 180) {
    const extension = extname(sanitized);
    const extensionRunes = [...extension];
    const keep = Math.max(1, 180 - extensionRunes.length);
    sanitized = `${runes.slice(0, keep).join("")}${extension}`;
  }
  return sanitized;
}

function addCollisionSuffix(path: string, sequence: number): string {
  const directory = dirname(path);
  const extension = extname(path);
  const name = basename(path, extension);
  const suffixed = `${name} (${sequence})${extension}`;
  return directory === "." ? suffixed : join(directory, suffixed);
}

export function buildDownloadFilePlan(nodes: TrackNode[], preferMedia = "all"): DownloadFile[] {
  const files: DownloadFile[] = [];
  function visit(items: TrackNode[], parents: string[]): void {
    for (const item of items) {
      const title = typeof item.title === "string" ? item.title : "";
      if (Array.isArray(item.children)) {
        visit(item.children, title ? [...parents, sanitizeDownloadPathSegment(title)] : parents);
      } else if (title && typeof item.mediaDownloadUrl === "string" && item.mediaDownloadUrl) {
        files.push({
          url: item.mediaDownloadUrl,
          relativePath: join(...parents, sanitizeDownloadPathSegment(title)),
          ...(Number.isFinite(item.size) && item.size! >= 0 ? { size: item.size } : {}),
        });
      }
    }
  }
  visit(nodes, []);

  const preference = preferMedia.toLowerCase().split(">").map((item) => item.trim());
  const audioExtensions = new Set([".mp3", ".wav", ".flac", ".mp3.vtt", ".wav.vtt", ".flac.vtt"]);
  const extensionOf = (path: string): string => {
    const lower = path.toLowerCase();
    return [...audioExtensions].find((extension) => lower.endsWith(extension)) ?? extname(lower);
  };
  let selected = files;
  if (!preference.includes("all")) {
    const nonAudio = files.filter((file) => !audioExtensions.has(extensionOf(file.relativePath)));
    for (const format of preference) {
      const audio = files.filter((file) => {
        const extension = extensionOf(file.relativePath);
        return extension === `.${format}` || extension === `.${format}.vtt`;
      });
      if (audio.length > 0) {
        selected = [...audio, ...nonAudio];
        break;
      }
    }
  }

  const used = new Set<string>();
  return selected.map((file) => {
    let relativePath = file.relativePath;
    let sequence = 2;
    while (used.has(relativePath.toLowerCase())) {
      relativePath = addCollisionSuffix(file.relativePath, sequence);
      sequence += 1;
    }
    used.add(relativePath.toLowerCase());
    return { ...file, relativePath };
  });
}

function stripWorkRoot(path: string, workId: number): string {
  const normalized = normalizePath(path);
  const separator = normalized.indexOf("/");
  if (separator < 0) return normalized;
  const first = normalized.slice(0, separator);
  const firstId = workIdFromArchiveName(`${first}.7z`);
  return firstId === workId ? normalized.slice(separator + 1) : normalized;
}

export function findMissingFiles(
  archiveEntries: ArchiveEntry[],
  expectedPaths: string[],
  workId: number,
): string[] {
  const actualPathCounts = new Map<string, number>();
  const actualNameCounts = new Map<string, number>();
  for (const entry of archiveEntries) {
    if (/(^|\s)D($|\s)/.test(entry.attributes)) continue;
    const normalized = stripWorkRoot(entry.path, workId);
    const pathKey = comparisonKey(normalized);
    const nameKey = comparisonKey(normalized.split("/").at(-1) ?? normalized);
    actualPathCounts.set(pathKey, (actualPathCounts.get(pathKey) ?? 0) + 1);
    actualNameCounts.set(nameKey, (actualNameCounts.get(nameKey) ?? 0) + 1);
  }

  const unmatched: string[] = [];
  for (const expected of expectedPaths) {
    const normalized = normalizePath(expected);
    const pathKey = comparisonKey(normalized);
    const pathCount = actualPathCounts.get(pathKey) ?? 0;
    if (pathCount > 0) {
      actualPathCounts.set(pathKey, pathCount - 1);
      const nameKey = comparisonKey(normalized.split("/").at(-1) ?? normalized);
      actualNameCounts.set(nameKey, (actualNameCounts.get(nameKey) ?? 1) - 1);
    } else {
      unmatched.push(normalized);
    }
  }

  const missing: string[] = [];
  for (const expected of unmatched) {
    const nameKey = comparisonKey(expected.split("/").at(-1) ?? expected);
    const nameCount = actualNameCounts.get(nameKey) ?? 0;
    if (nameCount > 0) actualNameCounts.set(nameKey, nameCount - 1);
    else missing.push(expected);
  }
  return missing;
}

async function checkArchive(
  archivePath: string,
  workId: number,
  config: Config,
  verifyWorkExists = false,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<IncompleteArchive | undefined> {
  try {
    if (verifyWorkExists) await fetchWorkById(workId, config, proxyUrl, throttle);
    const [archiveEntries, trackTree] = await Promise.all([
      listArchive(archivePath, config.sevenZipPath),
      fetchJson<TrackNode[]>(
        `${API_BASE_URL}/api/tracks/${workId}?v=2`,
        config.requestTimeoutMs,
        4,
        proxyUrl,
        throttle,
      ),
    ]);
    if (!Array.isArray(trackTree)) throw new Error("文件列表 API 返回了无法识别的数据结构");
    const expectedPaths = flattenTrackTree(trackTree);
    if (expectedPaths.length === 0) throw new Error("网站文件列表为空，无法判断完整性");
    const missingFiles = findMissingFiles(archiveEntries, expectedPaths, workId);
    if (missingFiles.length > 0) return { archivePath, workId, missingFiles };
    return undefined;
  } catch (error) {
    return { archivePath, workId, missingFiles: [], error: errorMessage(error) };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024 || nextUnit === units.at(-1)) break;
  }
  return `${value.toFixed(2)} ${unit}`;
}

export function parseFileSize(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|K(?:I)?B|M(?:I)?B|G(?:I)?B|T(?:I)?B)$/i);
  if (!match) {
    throw new Error(`无法识别下载体积“${value}”；请使用 B、KB、MB、GB 或 TB，例如 100 GB`);
  }
  const powers: Record<string, number> = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };
  const bytes = Number(match[1]) * 1024 ** powers[match[2].toUpperCase()];
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > Number.MAX_SAFE_INTEGER) {
    throw new Error(`下载体积必须在 1 B 到 ${Number.MAX_SAFE_INTEGER} B 之间`);
  }
  return Math.floor(bytes);
}

export function hasReachedDownloadSizeLimit(downloadedSize: number, maxDownloadSize?: number): boolean {
  return maxDownloadSize !== undefined && downloadedSize >= maxDownloadSize;
}

export async function buildDeletionPlan(
  incomplete: IncompleteArchive[],
  archiveDir: string,
): Promise<DeletionCandidate[]> {
  const root = resolve(archiveDir);
  const candidates: DeletionCandidate[] = [];
  for (const item of incomplete) {
    if (item.error || item.missingFiles.length === 0) continue;
    const archivePath = resolve(item.archivePath);
    if (!containsPath(root, archivePath) || archivePath === root) {
      throw new Error(`拒绝删除 archiveDir 之外的文件：${archivePath}`);
    }
    if (extname(archivePath).toLowerCase() !== ".7z") {
      throw new Error(`拒绝删除非 7z 文件：${archivePath}`);
    }
    const info = await stat(archivePath);
    if (!info.isFile()) throw new Error(`删除候选不是普通文件：${archivePath}`);
    candidates.push({ archivePath, workId: item.workId, size: info.size });
  }
  return candidates;
}

export async function deleteArchives(candidates: DeletionCandidate[]): Promise<DeletionFailure[]> {
  const failures: DeletionFailure[] = [];
  for (const candidate of candidates) {
    try {
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
  const candidates = new Map<string, NonAuthorDeletionCandidate>();

  for (const work of works) {
    const targetPath = resolve(work.path);
    const allowedRoots = work.type === "压缩包" ? [archiveRoot] : folderRoots;
    if (!allowedRoots.some((root) => targetPath !== root && containsPath(root, targetPath))) {
      throw new Error(
        `拒绝删除允许目录之外的${work.type}：${targetPath}`,
      );
    }

    const targetId = workIdFromArchiveName(
      work.type === "文件夹" ? `${basename(targetPath)}.7z` : targetPath,
    );
    if (targetId !== work.workId) {
      throw new Error(`删除目标的 RJ 编号与清单不一致：${targetPath}`);
    }

    let info;
    try {
      info = await lstat(targetPath);
    } catch (error) {
      throw new Error(`无法使用删除目标 ${targetPath}：${errorMessage(error)}`);
    }
    if (info.isSymbolicLink()) throw new Error(`拒绝删除符号链接：${targetPath}`);
    if (work.type === "压缩包") {
      if (extname(targetPath).toLowerCase() !== ".7z" || !info.isFile()) {
        throw new Error(`删除目标不是普通 7z 文件：${targetPath}`);
      }
    } else if (!/^RJ\d+$/i.test(basename(targetPath)) || !info.isDirectory()) {
      throw new Error(`删除目标不是标准 RJ 作品文件夹：${targetPath}`);
    }

    const key = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
    const candidate = {
      ...work,
      path: targetPath,
      size: work.type === "压缩包" ? info.size : await directorySize(targetPath),
    };
    const existing = candidates.get(key);
    if (existing && (existing.workId !== candidate.workId || existing.type !== candidate.type)) {
      throw new Error(`待删除清单对同一路径存在冲突记录：${targetPath}`);
    }
    candidates.set(key, candidate);
  }

  const planned = [...candidates.values()];
  return planned.filter((candidate) =>
    !planned.some((parent) =>
      parent.type === "文件夹" && parent.path !== candidate.path && containsPath(parent.path, candidate.path)
    )
  );
}

export async function deleteNonAuthorWorks(
  candidates: NonAuthorDeletionCandidate[],
): Promise<NonAuthorDeletionFailure[]> {
  const failures: NonAuthorDeletionFailure[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.type === "压缩包") await unlink(candidate.path);
      else await rm(candidate.path, { recursive: true, force: false });
    } catch (error) {
      failures.push({ path: candidate.path, error: errorMessage(error) });
    }
  }
  return failures;
}

async function confirmDeletion(count: number, noun = "文件"): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`确认永久删除以上 ${count} 个${noun}？输入 DELETE 继续：`);
    return answer.trim() === "DELETE";
  } finally {
    readline.close();
  }
}

async function previewAndDeleteIncomplete(
  incomplete: IncompleteArchive[],
  config: Config,
): Promise<void> {
  const candidates = await buildDeletionPlan(incomplete, config.archiveDir);
  const totalSize = candidates.reduce((sum, item) => sum + item.size, 0);

  console.log("\n删除预览：");
  console.log(`确认不完整：${candidates.length} 个`);
  console.log(`文件总大小：${formatFileSize(totalSize)}（${totalSize} 字节）`);
  if (candidates.length === 0) {
    console.log("没有确认不完整的压缩包可删除。");
    return;
  }

  console.log("文件列表：");
  for (const [index, candidate] of candidates.entries()) {
    console.log(`${index + 1}. [${formatFileSize(candidate.size)}] ${candidate.archivePath}`);
  }
  console.log("");

  if (!(await confirmDeletion(candidates.length))) {
    console.log("已取消，未删除任何文件。");
    return;
  }

  const failures = await deleteArchives(candidates);
  const deletedCount = candidates.length - failures.length;
  console.log(`删除完成：成功 ${deletedCount} 个，失败 ${failures.length} 个，释放 ${formatFileSize(
    candidates.filter((candidate) => !failures.some((failure) => failure.archivePath === candidate.archivePath))
      .reduce((sum, candidate) => sum + candidate.size, 0),
  )}。`);
  for (const failure of failures) console.error(`删除失败：${failure.archivePath}：${failure.error}`);
  if (failures.length > 0) process.exitCode = 2;
}

async function previewAndDeleteNonAuthorWorks(
  works: NonAuthorWork[],
  config: Config,
): Promise<void> {
  const candidates = await buildNonAuthorDeletionPlan(works, config.archiveDir, config.downloadDir);
  const totalSize = candidates.reduce((sum, item) => sum + item.size, 0);
  const archiveCount = candidates.filter((item) => item.type === "压缩包").length;
  const folderCount = candidates.length - archiveCount;

  console.log("\n删除预览：");
  console.log(`非该作者作品：${candidates.length} 项（压缩包 ${archiveCount} 个，文件夹 ${folderCount} 个）`);
  console.log(`总大小：${formatFileSize(totalSize)}（${totalSize} 字节）`);
  if (candidates.length === 0) {
    console.log("没有非该作者作品可删除。");
    return;
  }

  console.log("目标列表：");
  for (const [index, candidate] of candidates.entries()) {
    console.log(
      `${index + 1}. [${candidate.type}] [${formatFileSize(candidate.size)}] ` +
      `${displayWorkId(candidate.workId)} ${candidate.path}`,
    );
  }
  console.log("");

  if (!(await confirmDeletion(candidates.length, "项目"))) {
    console.log("已取消，未删除任何内容。");
    return;
  }

  const failures = await deleteNonAuthorWorks(candidates);
  const deleted = candidates.filter((candidate) =>
    !failures.some((failure) => failure.path === candidate.path)
  );
  console.log(
    `删除完成：成功 ${deleted.length} 项，失败 ${failures.length} 项，释放 ${formatFileSize(
      deleted.reduce((sum, candidate) => sum + candidate.size, 0),
    )}。`,
  );
  for (const failure of failures) console.error(`删除失败：${failure.path}：${failure.error}`);
  if (failures.length > 0) process.exitCode = 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayWorkId(id: number): string {
  return formatWorkId(id);
}

export function parseDownloadQueue(text: string): number[] {
  const ids = new Set<number>();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (index === 0 && line.startsWith("作品ID\t")) continue;
    const value = line.split("\t", 1)[0].trim();
    if (!/^RJ\d+$/i.test(value)) throw new Error(`待下载汇总中存在无效作品编号：${value}`);
    const id = workIdFromArchiveName(`${value}.7z`);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

export function parseDeletionQueue(text: string): IncompleteArchive[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== "作品ID\t压缩包路径") {
    throw new Error("待删除清单格式无效，请重新运行 author 或 archives 模式");
  }
  return lines.slice(1).map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error(`待删除清单中存在无效记录：${line}`);
    const displayId = line.slice(0, separator).trim();
    const archivePath = line.slice(separator + 1).trim();
    if (!/^RJ\d+$/i.test(displayId) || !archivePath) {
      throw new Error(`待删除清单中存在无效记录：${line}`);
    }
    const workId = workIdFromArchiveName(`${displayId}.7z`);
    if (workId === undefined) throw new Error(`待删除清单中存在无效作品编号：${displayId}`);
    return { archivePath, workId, missingFiles: ["来自检查结果"] };
  });
}

export function buildDeletionQueue(incomplete: IncompleteArchive[]): string {
  const lines = [
    "作品ID\t压缩包路径",
    ...incomplete
      .filter((item) => !item.error && item.missingFiles.length > 0)
      .map((item) => `${displayWorkId(item.workId)}\t${sanitizeColumn(item.archivePath)}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function findNonAuthorWorks(
  authorWorkIds: Iterable<number>,
  archives: Array<{ path: string; workId: number }>,
  folders: Array<{ path: string; workId: number }>,
): NonAuthorWork[] {
  const authorIds = new Set(authorWorkIds);
  return [
    ...archives.map((archive) => ({ ...archive, type: "压缩包" as const })),
    ...folders.map((folder) => ({ ...folder, type: "文件夹" as const })),
  ]
    .filter((item) => !authorIds.has(item.workId))
    .sort((left, right) =>
      left.workId - right.workId ||
      (left.type === right.type ? 0 : left.type === "压缩包" ? -1 : 1) ||
      left.path.localeCompare(right.path)
    );
}

export function buildNonAuthorWorkList(works: NonAuthorWork[]): string {
  const lines = [
    "作品ID\t类型\t路径",
    ...works.map((work) =>
      `${displayWorkId(work.workId)}\t${work.type}\t${sanitizeColumn(work.path)}`
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function parseNonAuthorWorkList(text: string): NonAuthorWork[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== "作品ID\t类型\t路径") {
    throw new Error("非该作者作品清单格式无效，请重新运行 author 模式");
  }
  return lines.slice(1).map((line) => {
    const columns = line.split("\t");
    if (columns.length !== 3) throw new Error(`非该作者作品清单中存在无效记录：${line}`);
    const [displayId, type, targetPath] = columns.map((column) => column.trim());
    if (!/^RJ\d+$/i.test(displayId) || (type !== "压缩包" && type !== "文件夹") || !targetPath) {
      throw new Error(`非该作者作品清单中存在无效记录：${line}`);
    }
    const workId = workIdFromArchiveName(`${displayId}.7z`);
    if (workId === undefined) throw new Error(`非该作者作品清单中存在无效作品编号：${displayId}`);
    return { path: targetPath, workId, type };
  });
}

async function readDeletionQueue(outputDir: string): Promise<IncompleteArchive[]> {
  const path = join(outputDir, DELETE_QUEUE_FILE_NAME);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`未找到待删除清单：${path}，请先重新运行 author 或 archives 模式`);
  }
  return parseDeletionQueue(await file.text());
}

async function readNonAuthorWorkList(outputDir: string): Promise<NonAuthorWork[]> {
  const path = join(outputDir, NON_AUTHOR_FILE_NAME);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`未找到非该作者作品清单：${path}，请先运行 author 模式`);
  }
  return parseNonAuthorWorkList(await file.text());
}

async function readOutputSnapshot(outputDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const name of [
    INCOMPLETE_FILE_NAME,
    MISSING_FILE_NAME,
    DOWNLOAD_QUEUE_FILE_NAME,
    DELETE_QUEUE_FILE_NAME,
    NON_AUTHOR_FILE_NAME,
  ]) {
    const file = Bun.file(join(outputDir, name));
    if (await file.exists()) snapshot.set(name, await file.text());
  }
  if (!snapshot.has(DOWNLOAD_QUEUE_FILE_NAME)) {
    throw new Error(`未找到待下载汇总：${join(outputDir, DOWNLOAD_QUEUE_FILE_NAME)}，请先运行 author 或 archives 模式`);
  }
  return snapshot;
}

async function restoreOutputSnapshot(outputDir: string, snapshot: Map<string, string>): Promise<void> {
  await Promise.all([...snapshot].map(([name, contents]) => Bun.write(join(outputDir, name), contents)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseTomlValue(text: string, section: string, key: string): string | undefined {
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
    if (!valueMatch) continue;
    return valueMatch[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

export function createRequestThrottle(requestsPerSecond: number): RequestThrottle {
  const intervalMs = 1_000 / requestsPerSecond;
  let nextRequestAt = 0;
  let queue = Promise.resolve();

  return () => {
    const scheduled = queue.then(async () => {
      const now = Date.now();
      const delayMs = Math.max(0, nextRequestAt - now);
      if (delayMs > 0) await Bun.sleep(delayMs);
      nextRequestAt = Math.max(Date.now(), nextRequestAt) + intervalMs;
    });
    queue = scheduled.catch(() => undefined);
    return scheduled;
  };
}

async function readDownloaderSettings(workingDirectory: string, config: Config): Promise<DownloaderSettings> {
  const settings: DownloaderSettings = {
    maxRetries: 3,
    maxWorkers: config.concurrency,
    preferMedia: "all",
    proxyUrl: "",
    requestTimeoutMs: config.requestTimeoutMs,
    syncQps: 2,
  };
  const file = Bun.file(join(workingDirectory, ".asmroner-data", "config.toml"));
  if (!(await file.exists())) return settings;
  const text = await file.text();
  const maxRetries = Number.parseInt(parseTomlValue(text, "downloader", "max_retries") ?? "", 10);
  const maxWorkers = Number.parseInt(parseTomlValue(text, "downloader", "max_workers") ?? "", 10);
  const syncQps = Number.parseFloat(parseTomlValue(text, "limit", "sync_qps") ?? "");
  if (Number.isInteger(maxRetries) && maxRetries >= 0) settings.maxRetries = maxRetries;
  if (Number.isInteger(maxWorkers) && maxWorkers > 0) settings.maxWorkers = Math.min(maxWorkers, 20);
  settings.preferMedia = parseTomlValue(text, "downloader", "prefer_media") || settings.preferMedia;
  settings.proxyUrl = parseTomlValue(text, "downloader", "proxy_url") || "";
  if (Number.isFinite(syncQps) && syncQps > 0) settings.syncQps = syncQps;
  return settings;
}

async function downloadFile(
  file: DownloadFile,
  root: string,
  settings: DownloaderSettings,
): Promise<"downloaded" | "skipped"> {
  const targetPath = join(root, file.relativePath);
  const partialPath = `${targetPath}.asmr-archive-checker-part`;
  await mkdir(dirname(targetPath), { recursive: true });
  if (await pathExists(targetPath)) {
    const existing = await stat(targetPath);
    if (existing.isFile() && isCompleteDownloadFile(existing.size, file.size)) return "skipped";
    if (!existing.isFile()) throw new Error(`${file.relativePath}：目标路径存在但不是文件`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    const controller = new AbortController();
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (attempt > 0) {
        console.warn(`重试 ${attempt}/${settings.maxRetries}：${file.relativePath}（${errorMessage(lastError)}）`);
        await Bun.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
      await rm(partialPath, { force: true });
      requestTimer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
      const response = await fetch(file.url, {
        headers: { "User-Agent": "asmr-archive-checker/1.0" },
        signal: controller.signal,
        ...(settings.proxyUrl ? { proxy: settings.proxyUrl } : {}),
      });
      clearTimeout(requestTimer);
      requestTimer = undefined;
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      await writeResponseBodyToFile(
        response,
        partialPath,
        controller,
        settings.requestTimeoutMs,
      );
      if (file.size !== undefined) {
        const downloaded = await stat(partialPath);
        if (downloaded.size !== file.size) {
          throw new Error(`文件大小不符：预期 ${file.size}，实际 ${downloaded.size}`);
        }
      }
      // 只有新的临时文件完整落盘后，才替换旧的错误大小文件。
      await rm(targetPath, { force: true });
      await rename(partialPath, targetPath);
      return "downloaded";
    } catch (error) {
      lastError = error;
    } finally {
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      controller.abort();
    }
  }
  await rm(partialPath, { force: true }).catch(() => undefined);
  throw new Error(`${file.relativePath}：${errorMessage(lastError)}`);
}

export async function writeResponseBodyToFile(
  response: Response,
  path: string,
  controller: AbortController,
  inactivityTimeoutMs: number,
): Promise<void> {
  if (!response.body) throw new Error("下载响应没有文件内容");
  const reader = response.body.getReader();
  const file = await open(path, "w");
  let position = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`连续 ${inactivityTimeoutMs} 毫秒没有收到下载数据`));
        }, inactivityTimeoutMs);
      });
      const chunk = await (async () => {
        try {
          return await Promise.race([reader.read(), timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      })();
      if (chunk.done) break;

      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const written = await file.write(
          chunk.value,
          offset,
          chunk.value.byteLength - offset,
          position,
        );
        if (written.bytesWritten <= 0) throw new Error("无法继续写入下载文件");
        offset += written.bytesWritten;
        position += written.bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

export function isCompleteDownloadFile(actualSize: number, expectedSize?: number): boolean {
  return expectedSize === undefined || actualSize === expectedSize;
}

async function directorySize(root: string): Promise<number> {
  let size = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) size += (await stat(path)).size;
    }
  }
  await visit(root);
  return size;
}

export async function prepareBuiltinStagingPath(stagingRoot: string, displayId: string): Promise<string> {
  const stablePath = join(stagingRoot, displayId);
  if (await pathExists(stablePath)) {
    const existing = await stat(stablePath);
    if (!existing.isDirectory()) throw new Error(`下载临时路径存在但不是文件夹：${stablePath}`);
    return stablePath;
  }

  // 兼容旧版本创建的随机临时目录，优先复用已下载数据最多的一份。
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${displayId}-`))
    .map((entry) => join(stagingRoot, entry.name));
  if (candidates.length > 0) {
    const sizes = await Promise.all(candidates.map(async (path) => ({ path, size: await directorySize(path) })));
    sizes.sort((a, b) => b.size - a.size);
    await rename(sizes[0].path, stablePath);
    console.log(`继续上次下载：${stablePath}`);
    return stablePath;
  }

  await mkdir(stablePath);
  return stablePath;
}

async function downloadWithBuiltin(workId: number, stagingPath: string, config: Config): Promise<void> {
  const workingDirectory = resolve(".");
  const settings = await readDownloaderSettings(workingDirectory, config);
  const trackTree = await fetchJson<TrackNode[]>(
    `${API_BASE_URL}/api/tracks/${workId}?v=2`,
    config.requestTimeoutMs,
    4,
    settings.proxyUrl,
  );
  if (!Array.isArray(trackTree)) throw new Error("文件列表 API 返回了无法识别的数据结构");
  const files = buildDownloadFilePlan(trackTree, settings.preferMedia);
  if (files.length === 0) throw new Error("网站文件列表为空，无法下载");

  console.log(`Windows 内置下载器：${files.length} 个文件，并发 ${settings.maxWorkers}`);
  let finished = 0;
  let reused = 0;
  const errors = await mapLimit(files, settings.maxWorkers, async (file) => {
    try {
      const status = await downloadFile(file, stagingPath, settings);
      finished += 1;
      if (status === "skipped") reused += 1;
      console.log(`[${finished}/${files.length}] ${status === "skipped" ? "已下载" : "完成"} ${file.relativePath}`);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  const failures = errors.filter((error): error is string => typeof error === "string");
  if (failures.length > 0) throw new Error(`${failures.length} 个文件下载失败；首个错误：${failures[0]}`);
  if (reused > 0) console.log(`复用了 ${reused} 个已下载文件`);
}

async function downloadWithAsmroner(displayId: string, stagingPath: string, config: Config): Promise<void> {
  const child = Bun.spawn(
    [config.downloaderPath, "download", displayId, "-d", stagingPath],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`asmroner 返回代码 ${exitCode}`);
}

async function downloadWork(workId: number, config: Config): Promise<DownloadResult> {
  const displayId = displayWorkId(workId);
  const targetPath = join(config.downloadDir, displayId);
  if (await pathExists(targetPath)) {
    const target = await stat(targetPath);
    if (target.isDirectory()) return { workId, displayId, status: "skipped", targetPath };
    return { workId, displayId, status: "failed", error: `目标路径存在但不是文件夹：${targetPath}` };
  }

  const stagingRoot = join(config.downloadDir, ".asmr-archive-checker-downloads");
  let stagingPath = join(stagingRoot, displayId);
  try {
    await mkdir(stagingRoot, { recursive: true });
    stagingPath = process.platform === "win32"
      ? await prepareBuiltinStagingPath(stagingRoot, displayId)
      : await mkdtemp(join(stagingRoot, `${displayId}-`));
    console.log(`下载完整作品 ${displayId} ...`);
    if (process.platform === "win32") await downloadWithBuiltin(workId, stagingPath, config);
    else await downloadWithAsmroner(displayId, stagingPath, config);

    if (await pathExists(targetPath)) throw new Error(`目标文件夹已存在：${targetPath}`);
    let completedPath = stagingPath;
    if (process.platform === "win32") {
      const size = await directorySize(completedPath);
      await rename(stagingPath, targetPath);
      return { workId, displayId, status: "downloaded", targetPath, size };
    } else {
      const entries = await readdir(stagingPath, { withFileTypes: true });
      const folders = entries.filter((entry) => entry.isDirectory());
      if (folders.length !== 1) {
        throw new Error(`下载目录中应有 1 个作品文件夹，实际为 ${folders.length} 个`);
      }
      completedPath = join(stagingPath, folders[0].name);
      const size = await directorySize(completedPath);
      await rename(completedPath, targetPath);
      await rmdir(stagingPath).catch(() => undefined);
      return { workId, displayId, status: "downloaded", targetPath, size };
    }
  } catch (error) {
    return {
      workId,
      displayId,
      status: "failed",
      stagingPath,
      error: errorMessage(error),
    };
  }
}

export async function downloadWorks(
  workIds: number[],
  config: Config,
  downloadOne: (workId: number, config: Config) => Promise<DownloadResult> = downloadWork,
): Promise<DownloadBatchResult> {
  const uniqueIds = [...new Set(workIds)];
  const results: DownloadResult[] = [];
  let downloadedSize = 0;
  let stoppedByLimit = false;
  let attemptedCount = 0;
  for (const [index, workId] of uniqueIds.entries()) {
    console.log(`\n[作品 ${index + 1}/${uniqueIds.length}] ${displayWorkId(workId)}`);
    const result = await downloadOne(workId, config);
    results.push(result);
    attemptedCount += 1;
    if (result.status === "downloaded") {
      downloadedSize += result.size ?? 0;
      console.log(`作品完成：${result.displayId}（${formatFileSize(result.size ?? 0)}）`);
      if (hasReachedDownloadSizeLimit(downloadedSize, config.maxDownloadSizeBytes)) {
        stoppedByLimit = true;
        console.log(
          `已达到本次下载体积限制：${formatFileSize(downloadedSize)} / ` +
          `${formatFileSize(config.maxDownloadSizeBytes!)}；当前作品已完整下载，停止后续下载。`,
        );
        break;
      }
    }
    else if (result.status === "skipped") console.log(`作品已存在，跳过：${result.displayId}`);
    else {
      console.error(`作品失败：${result.displayId}：${result.error}`);
      if (result.stagingPath) console.error(`可续传临时目录：${result.stagingPath}`);
    }
  }

  const failedIndexes = results
    .map((result, index) => result.status === "failed" ? index : -1)
    .filter((index) => index >= 0);
  if (!stoppedByLimit && failedIndexes.length > 0) {
    console.log(`\n首轮有 ${failedIndexes.length} 部作品失败，开始续传重试。`);
    for (const [retryIndex, resultIndex] of failedIndexes.entries()) {
      const workId = uniqueIds[resultIndex];
      console.log(`\n[重试 ${retryIndex + 1}/${failedIndexes.length}] ${displayWorkId(workId)}`);
      const result = await downloadOne(workId, config);
      results[resultIndex] = result;
      if (result.status === "downloaded") {
        downloadedSize += result.size ?? 0;
        console.log(`重试完成：${result.displayId}（${formatFileSize(result.size ?? 0)}）`);
        if (hasReachedDownloadSizeLimit(downloadedSize, config.maxDownloadSizeBytes)) {
          stoppedByLimit = true;
          console.log(
            `已达到本次下载体积限制：${formatFileSize(downloadedSize)} / ` +
            `${formatFileSize(config.maxDownloadSizeBytes!)}；当前作品已完整下载，停止后续重试。`,
          );
          break;
        }
      }
      else if (result.status === "skipped") console.log(`作品已存在，跳过：${result.displayId}`);
      else {
        console.error(`重试失败：${result.displayId}：${result.error}`);
        if (result.stagingPath) console.error(`可续传临时目录：${result.stagingPath}`);
      }
    }
  }
  return {
    results,
    downloadedSize,
    stoppedByLimit,
    remainingCount: uniqueIds.length - attemptedCount,
  };
}

async function writeResults(
  config: Config,
  works: SearchWork[],
  recognizedArchives: Array<{ path: string; workId: number }>,
  incomplete: IncompleteArchive[],
  downloadedFolders: Array<{ path: string; workId: number }>,
  nonAuthorWorks?: NonAuthorWork[],
): Promise<void> {
  await mkdir(config.outputDir, { recursive: true });
  const downloadedIds = new Set([
    ...recognizedArchives.map((archive) => archive.workId),
    ...downloadedFolders.map((folder) => folder.workId),
  ]);
  const missingWorks = works.filter((work) => !downloadedIds.has(work.id));
  const incompletePath = join(config.outputDir, INCOMPLETE_FILE_NAME);
  const missingPath = join(config.outputDir, MISSING_FILE_NAME);
  const downloadQueuePath = join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME);
  const deleteQueuePath = join(config.outputDir, DELETE_QUEUE_FILE_NAME);
  const nonAuthorPath = join(config.outputDir, NON_AUTHOR_FILE_NAME);

  const incompleteText = incomplete.length > 0
    ? `${incomplete.map((item) => item.archivePath).join("\n")}\n`
    : "";
  const missingLines = ["作品ID\t标题\t发布日期"];
  for (const work of missingWorks) {
    missingLines.push(`${displayWorkId(work.id)}\t${sanitizeColumn(work.title)}\t${sanitizeColumn(work.release)}`);
  }
  const queue = new Map<number, string>();
  for (const item of incomplete) {
    const reason = item.error ? "检查失败" : "不完整";
    queue.set(item.workId, `${displayWorkId(item.workId)}\t${reason}\t${sanitizeColumn(item.archivePath)}`);
  }
  for (const work of missingWorks) {
    if (!queue.has(work.id)) {
      queue.set(work.id, `${displayWorkId(work.id)}\t遗漏\t${sanitizeColumn(work.title)}`);
    }
  }
  const queueLines = ["作品ID\t原因\t来源", ...queue.values()];

  const writes = [
    Bun.write(incompletePath, incompleteText),
    Bun.write(missingPath, `${missingLines.join("\n")}\n`),
    Bun.write(downloadQueuePath, `${queueLines.join("\n")}\n`),
    Bun.write(deleteQueuePath, buildDeletionQueue(incomplete)),
  ];
  if (nonAuthorWorks !== undefined) {
    writes.push(Bun.write(nonAuthorPath, buildNonAuthorWorkList(nonAuthorWorks)));
  }
  await Promise.all(writes);
}

function sanitizeColumn(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\t\r\n]+/g, " ") : "";
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const cli = parseArgs(args);
  if (cli.help) {
    console.log(usage());
    return;
  }
  const config = await loadConfig(cli);

  if (cli.mode === "delete") {
    await requireDirectory(config.archiveDir, "archiveDir");
    await requireDirectory(config.outputDir, "outputDir");
    const incomplete = await readDeletionQueue(config.outputDir);
    console.log("模式：delete");
    console.log(`读取检查结果：${join(config.outputDir, DELETE_QUEUE_FILE_NAME)}`);
    await previewAndDeleteIncomplete(incomplete, config);
    console.log(`结果目录：${config.outputDir}`);
    return;
  }

  if (cli.mode === "delete-non-author") {
    await requireDirectory(config.archiveDir, "archiveDir");
    await requireDirectory(config.outputDir, "outputDir");
    const works = await readNonAuthorWorkList(config.outputDir);
    console.log("模式：delete-non-author");
    console.log(`读取检查结果：${join(config.outputDir, NON_AUTHOR_FILE_NAME)}`);
    await previewAndDeleteNonAuthorWorks(works, config);
    console.log(`结果清单保留在：${join(config.outputDir, NON_AUTHOR_FILE_NAME)}`);
    return;
  }

  if (cli.mode === "download") {
    await ensureDirectory(config.outputDir, "outputDir");
    const snapshot = await readOutputSnapshot(config.outputDir);
    const workIds = parseDownloadQueue(snapshot.get(DOWNLOAD_QUEUE_FILE_NAME)!);
    await ensureDirectory(config.downloadDir, "downloadDir");
    await ensureDirectory(join(config.downloadDir, ".asmr-archive-checker-downloads"), "下载临时目录");
    await prepareOutputDirectory(config);
    await restoreOutputSnapshot(config.outputDir, snapshot);
    console.log("模式：download");
    console.log(`下载目录：${config.downloadDir}`);
    console.log(`待下载作品：${workIds.length} 个`);
    if (config.maxDownloadSizeBytes !== undefined) {
      console.log(`本次下载体积限制：${formatFileSize(config.maxDownloadSizeBytes)}`);
    } else {
      console.log("本次下载体积限制：不限制");
    }
    const batch = await downloadWorks(workIds, config);
    const downloads = batch.results;
    console.log(
      `本次结束：下载成功 ${downloads.filter((item) => item.status === "downloaded").length} 个，` +
      `已存在 ${downloads.filter((item) => item.status === "skipped").length} 个，` +
      `失败 ${downloads.filter((item) => item.status === "failed").length} 个，` +
      `下载体积 ${formatFileSize(batch.downloadedSize)}。`,
    );
    if (batch.stoppedByLimit && batch.remainingCount > 0) {
      console.log(`因达到体积限制停止，队列中还有 ${batch.remainingCount} 部作品未开始。`);
    }
    if (downloads.some((item) => item.status === "failed")) process.exitCode = 2;
    return;
  }

  await requireDirectory(config.archiveDir, "archiveDir");
  await prepareOutputDirectory(config);
  console.log(`模式：${cli.mode}`);
  if (cli.mode === "author") console.log(`作者：${config.author}`);
  console.log(`7z 目录：${config.archiveDir}`);

  const folderRoots = cli.mode === "author"
    ? [...new Set([config.archiveDir, config.downloadDir].filter(Boolean))]
    : [];
  const [archives, downloadedFolderGroups] = await Promise.all([
    findArchives(config.archiveDir),
    Promise.all(folderRoots.map((root) => findDownloadedWorkFolders(root))),
  ]);
  const downloadedFolders = [
    ...new Map(downloadedFolderGroups.flat().map((folder) => [folder.path, folder])).values(),
  ];
  const recognizedArchives = archives
    .map((path) => ({ path, workId: workIdFromArchiveName(path) }))
    .filter((item): item is { path: string; workId: number } => item.workId !== undefined);
  const unknownArchives = archives.filter((path) => workIdFromArchiveName(path) === undefined);
  const apiSettings = await readDownloaderSettings(resolve("."), config);
  const apiThrottle = createRequestThrottle(apiSettings.syncQps);
  console.log(`API 请求速率：每秒最多 ${apiSettings.syncQps} 次`);
  const works = cli.mode === "author"
    ? await fetchAllWorks(config, apiSettings.proxyUrl, apiThrottle)
    : [];
  const websiteIds = new Set(works.map((work) => work.id));
  const archivesToCheck = cli.mode === "author"
    ? recognizedArchives.filter((archive) => websiteIds.has(archive.workId))
    : recognizedArchives;
  const nonAuthorWorks = cli.mode === "author"
    ? findNonAuthorWorks(websiteIds, recognizedArchives, downloadedFolders)
    : undefined;

  const websiteSummary = cli.mode === "author" ? `网站作品：${works.length} 个；` : "";
  console.log(`${websiteSummary}找到 7z：${archives.length} 个；需要核对：${archivesToCheck.length} 个`);
  if (unknownArchives.length > 0) console.log(`无法识别 RJ 编号的 7z：${unknownArchives.length} 个`);
  const checked = await mapLimit(archivesToCheck, config.concurrency, async (archive, index) => {
    console.log(`[${index + 1}/${archivesToCheck.length}] 检查 ${basename(archive.path)}`);
    return checkArchive(
      archive.path,
      archive.workId,
      config,
      cli.mode === "archives",
      apiSettings.proxyUrl,
      apiThrottle,
    );
  });
  const incomplete = checked.filter((item): item is IncompleteArchive => item !== undefined);
  const downloadedIds = new Set([
    ...recognizedArchives.map((archive) => archive.workId),
    ...downloadedFolders.map((folder) => folder.workId),
  ]);
  await writeResults(
    config,
    works,
    recognizedArchives,
    incomplete,
    downloadedFolders,
    nonAuthorWorks,
  );

  const missingCount = works.filter((work) => !downloadedIds.has(work.id)).length;
  console.log(`完成：不完整压缩包 ${incomplete.length} 个，遗漏下载作品 ${missingCount} 个。`);
  if (nonAuthorWorks !== undefined) {
    const nonAuthorWorkCount = new Set(nonAuthorWorks.map((work) => work.workId)).size;
    console.log(
      `非该作者作品 ${nonAuthorWorkCount} 部（${nonAuthorWorks.length} 个本地压缩包或文件夹）：` +
      join(config.outputDir, NON_AUTHOR_FILE_NAME),
    );
  }
  console.log(`待下载汇总：${join(config.outputDir, DOWNLOAD_QUEUE_FILE_NAME)}`);
  console.log(`结果目录：${config.outputDir}`);
  if (incomplete.some((item) => item.error)) process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`错误：${errorMessage(error)}`);
    console.error(usage());
    process.exitCode = 1;
  });
}
