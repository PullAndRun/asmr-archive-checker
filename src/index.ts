import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const API_BASE_URL = "https://api.asmr-200.com";
const SEARCH_PAGE_SIZE = 100;
const INCOMPLETE_FILE_NAME = "不完整的压缩包.txt";
const MISSING_FILE_NAME = "遗漏下载的音声.txt";
const DOWNLOAD_QUEUE_FILE_NAME = "待下载的音声.txt";

export type Config = {
  author: string;
  archiveDir: string;
  downloadDir: string;
  outputDir: string;
  sevenZipPath: string;
  downloaderPath: string;
  concurrency: number;
  requestTimeoutMs: number;
};

export type Mode = "author" | "archives" | "download";

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
};

type ArchiveEntry = {
  path: string;
  attributes: string;
};

type IncompleteArchive = {
  archivePath: string;
  workId: number;
  missingFiles: string[];
  error?: string;
};

type DownloadResult = {
  workId: number;
  displayId: string;
  status: "downloaded" | "skipped" | "failed";
  targetPath?: string;
  stagingPath?: string;
  error?: string;
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
};

function usage(): string {
  return `用法：bun run check -- <命令> [选项]

命令：
  author                按作者核对并汇总遗漏和不完整作品
  archives              检查目录内每一个 7z，汇总不完整作品
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
  -h, --help            显示帮助`;
}

export function parseArgs(args: string[]): CliOptions {
  const values = [...args];
  if (values[0] === "--") values.shift();
  let mode: Mode = "author";
  if (values[0] === "author" || values[0] === "archives" || values[0] === "download") {
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

  merged.author = merged.author.trim();
  merged.archiveDir = resolvePath(configBase, merged.archiveDir);
  merged.downloadDir = merged.downloadDir.trim()
    ? resolvePath(configBase, merged.downloadDir)
    : "";
  merged.outputDir = resolvePath(configBase, merged.outputDir);
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
  return `RJ${String(id).padStart(8, "0")}`;
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

async function fetchJson<T>(url: string, timeoutMs: number, attempts = 4, proxyUrl = ""): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
      if (attempt < attempts) await Bun.sleep(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`请求失败 ${url}：${errorMessage(lastError)}`);
}

async function fetchAllWorks(config: Config): Promise<SearchWork[]> {
  const first = await fetchJson<SearchResponse>(buildSearchUrl(config.author, 1), config.requestTimeoutMs);
  validateSearchResponse(first);
  const totalPages = Math.max(1, Math.ceil(first.pagination.totalCount / first.pagination.pageSize));
  const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const responses = await mapLimit(remainingPages, config.concurrency, async (page) => {
    process.stdout.write(`\r正在读取作者作品列表：${page}/${totalPages}`);
    const response = await fetchJson<SearchResponse>(buildSearchUrl(config.author, page), config.requestTimeoutMs);
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

async function fetchWorkById(id: number, config: Config): Promise<SearchWork> {
  const response = await fetchJson<SearchResponse>(buildWorkSearchUrl(id), config.requestTimeoutMs);
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
  const match = basename(path).match(/RJ0*(\d+)/i);
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
): Promise<IncompleteArchive | undefined> {
  try {
    if (verifyWorkExists) await fetchWorkById(workId, config);
    const [archiveEntries, trackTree] = await Promise.all([
      listArchive(archivePath, config.sevenZipPath),
      fetchJson<TrackNode[]>(`${API_BASE_URL}/api/tracks/${workId}?v=2`, config.requestTimeoutMs),
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

async function readOutputSnapshot(outputDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const name of [INCOMPLETE_FILE_NAME, MISSING_FILE_NAME, DOWNLOAD_QUEUE_FILE_NAME]) {
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

async function readDownloaderSettings(workingDirectory: string, config: Config): Promise<DownloaderSettings> {
  const settings: DownloaderSettings = {
    maxRetries: 3,
    maxWorkers: config.concurrency,
    preferMedia: "all",
    proxyUrl: "",
  };
  const file = Bun.file(join(workingDirectory, ".asmroner-data", "config.toml"));
  if (!(await file.exists())) return settings;
  const text = await file.text();
  const maxRetries = Number.parseInt(parseTomlValue(text, "downloader", "max_retries") ?? "", 10);
  const maxWorkers = Number.parseInt(parseTomlValue(text, "downloader", "max_workers") ?? "", 10);
  if (Number.isInteger(maxRetries) && maxRetries >= 0) settings.maxRetries = maxRetries;
  if (Number.isInteger(maxWorkers) && maxWorkers > 0) settings.maxWorkers = Math.min(maxWorkers, 20);
  settings.preferMedia = parseTomlValue(text, "downloader", "prefer_media") || settings.preferMedia;
  settings.proxyUrl = parseTomlValue(text, "downloader", "proxy_url") || "";
  return settings;
}

async function downloadFile(
  file: DownloadFile,
  root: string,
  settings: DownloaderSettings,
): Promise<void> {
  const targetPath = join(root, file.relativePath);
  const partialPath = `${targetPath}.asmr-archive-checker-part`;
  await mkdir(dirname(targetPath), { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    try {
      if (attempt > 0) {
        console.warn(`重试 ${attempt}/${settings.maxRetries}：${file.relativePath}（${errorMessage(lastError)}）`);
        await Bun.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      }
      await rm(partialPath, { force: true });
      const response = await fetch(file.url, {
        headers: { "User-Agent": "asmr-archive-checker/1.0" },
        ...(settings.proxyUrl ? { proxy: settings.proxyUrl } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      await Bun.write(partialPath, response);
      if (file.size !== undefined) {
        const downloaded = await stat(partialPath);
        if (downloaded.size !== file.size) {
          throw new Error(`文件大小不符：预期 ${file.size}，实际 ${downloaded.size}`);
        }
      }
      await rename(partialPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  await rm(partialPath, { force: true }).catch(() => undefined);
  throw new Error(`${file.relativePath}：${errorMessage(lastError)}`);
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
  const errors = await mapLimit(files, settings.maxWorkers, async (file) => {
    try {
      await downloadFile(file, stagingPath, settings);
      finished += 1;
      console.log(`[${finished}/${files.length}] ${file.relativePath}`);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  const failures = errors.filter((error): error is string => typeof error === "string");
  if (failures.length > 0) throw new Error(`${failures.length} 个文件下载失败；首个错误：${failures[0]}`);
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
  await mkdir(stagingRoot, { recursive: true });
  const stagingPath = await mkdtemp(join(stagingRoot, `${displayId}-`));
  try {
    console.log(`下载完整作品 ${displayId} ...`);
    if (process.platform === "win32") await downloadWithBuiltin(workId, stagingPath, config);
    else await downloadWithAsmroner(displayId, stagingPath, config);

    if (await pathExists(targetPath)) throw new Error(`目标文件夹已存在：${targetPath}`);
    if (process.platform === "win32") {
      await rename(stagingPath, targetPath);
    } else {
      const entries = await readdir(stagingPath, { withFileTypes: true });
      const folders = entries.filter((entry) => entry.isDirectory());
      if (folders.length !== 1) {
        throw new Error(`下载目录中应有 1 个作品文件夹，实际为 ${folders.length} 个`);
      }
      await rename(join(stagingPath, folders[0].name), targetPath);
      await rmdir(stagingPath).catch(() => undefined);
    }
    return { workId, displayId, status: "downloaded", targetPath };
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

async function downloadWorks(workIds: number[], config: Config): Promise<DownloadResult[]> {
  const uniqueIds = [...new Set(workIds)].sort((a, b) => a - b);
  const results: DownloadResult[] = [];
  for (const workId of uniqueIds) results.push(await downloadWork(workId, config));
  return results;
}

async function writeResults(
  config: Config,
  works: SearchWork[],
  recognizedArchives: Array<{ path: string; workId: number }>,
  incomplete: IncompleteArchive[],
  downloadedFolders: Array<{ path: string; workId: number }>,
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

  await Promise.all([
    Bun.write(incompletePath, incompleteText),
    Bun.write(missingPath, `${missingLines.join("\n")}\n`),
    Bun.write(downloadQueuePath, `${queueLines.join("\n")}\n`),
  ]);
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
    const downloads = await downloadWorks(workIds, config);
    console.log(
      `完成：下载成功 ${downloads.filter((item) => item.status === "downloaded").length} 个，` +
      `已存在 ${downloads.filter((item) => item.status === "skipped").length} 个，` +
      `失败 ${downloads.filter((item) => item.status === "failed").length} 个。`,
    );
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
  const works = cli.mode === "author" ? await fetchAllWorks(config) : [];
  const websiteIds = new Set(works.map((work) => work.id));
  const archivesToCheck = cli.mode === "author"
    ? recognizedArchives.filter((archive) => websiteIds.has(archive.workId))
    : recognizedArchives;

  const websiteSummary = cli.mode === "author" ? `网站作品：${works.length} 个；` : "";
  console.log(`${websiteSummary}找到 7z：${archives.length} 个；需要核对：${archivesToCheck.length} 个`);
  if (unknownArchives.length > 0) console.log(`无法识别 RJ 编号的 7z：${unknownArchives.length} 个`);
  const checked = await mapLimit(archivesToCheck, config.concurrency, async (archive, index) => {
    console.log(`[${index + 1}/${archivesToCheck.length}] 检查 ${basename(archive.path)}`);
    return checkArchive(archive.path, archive.workId, config, cli.mode === "archives");
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
  );

  const missingCount = works.filter((work) => !downloadedIds.has(work.id)).length;
  console.log(`完成：不完整压缩包 ${incomplete.length} 个，遗漏下载作品 ${missingCount} 个。`);
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
