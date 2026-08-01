import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseFileSize } from "./domain/size.ts";
import { containsPath, errorMessage } from "./shared.ts";
import type { CliOptions, Config, Mode } from "./types.ts";

const DEFAULT_CONFIG: Config = {
  author: "",
  archiveDir: ".",
  downloadDir: "",
  outputDir: "./output",
  sevenZipPath: "7z",
  concurrency: 4,
  maxWorkers: 4,
  maxRetries: 3,
  proxyUrl: "",
  syncQps: 2,
  requestTimeoutMs: 30_000,
  archiveTimeoutMs: 300_000,
  maxDownloadSize: "",
};

export function usage(): string {
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
  --concurrency <数量>  API 并发数，默认 4
  --max-download-size <体积>
                        本次下载体积上限，例如 100 GB；默认不限制
  -h, --help            显示帮助`;
}

export function parseArgs(args: string[]): CliOptions {
  const values = [...args];
  if (values[0] === "--") values.shift();
  let mode: Mode = "author";
  if (["author", "archives", "delete", "delete-non-author", "download"].includes(values[0])) {
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
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${argument} 缺少值`);
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

const looksLikePath = (value: string): boolean =>
  value.includes("/") || value.includes("\\") || value.startsWith(".");

const resolvePath = (base: string, path: string): string =>
  isAbsolute(path) ? resolve(path) : resolve(base, path);

export async function loadConfig(cli: CliOptions): Promise<Config> {
  const explicitConfig = cli.configPath !== undefined;
  const configPath = resolve(cli.configPath ?? "config.json");
  let fileConfig: Partial<Config> = {};
  try {
    const parsed: unknown = await Bun.file(configPath).json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("配置文件根节点必须是 JSON 对象");
    }
    fileConfig = parsed as Partial<Config>;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (explicitConfig || code !== "ENOENT") {
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
    ...(cli.concurrency !== undefined ? { concurrency: cli.concurrency } : {}),
    ...(cli.maxDownloadSize !== undefined ? { maxDownloadSize: cli.maxDownloadSize } : {}),
  };

  if (typeof merged.author !== "string") throw new Error("author 必须是字符串");
  if (cli.mode === "author" && !merged.author.trim()) throw new Error("author 模式需要填写作者名");
  if (typeof merged.archiveDir !== "string" || !merged.archiveDir.trim()) throw new Error("archiveDir 必须是非空目录路径");
  if (typeof merged.downloadDir !== "string") throw new Error("downloadDir 必须是目录路径或空字符串");
  if (cli.mode === "download" && !merged.downloadDir.trim()) throw new Error("download 模式需要指定 downloadDir");
  if (typeof merged.outputDir !== "string" || !merged.outputDir.trim()) throw new Error("outputDir 必须是非空目录路径");
  if (typeof merged.sevenZipPath !== "string" || !merged.sevenZipPath.trim()) throw new Error("sevenZipPath 必须是非空命令或路径");
  if (!Number.isInteger(merged.concurrency) || merged.concurrency < 1 || merged.concurrency > 20) throw new Error("concurrency 必须是 1 到 20 之间的整数");
  if (!Number.isInteger(merged.maxWorkers) || merged.maxWorkers < 1 || merged.maxWorkers > 20) throw new Error("maxWorkers 必须是 1 到 20 之间的整数");
  if (!Number.isInteger(merged.maxRetries) || merged.maxRetries < 0 || merged.maxRetries > 20) throw new Error("maxRetries 必须是 0 到 20 之间的整数");
  if (typeof merged.proxyUrl !== "string") throw new Error("proxyUrl 必须是字符串");
  if (!Number.isFinite(merged.syncQps) || merged.syncQps <= 0 || merged.syncQps > 100) throw new Error("syncQps 必须是大于 0 且不超过 100 的数字");
  if (!Number.isFinite(merged.requestTimeoutMs) || merged.requestTimeoutMs < 1_000) throw new Error("requestTimeoutMs 必须不少于 1000 毫秒");
  if (!Number.isFinite(merged.archiveTimeoutMs) || merged.archiveTimeoutMs! < 1_000) throw new Error("archiveTimeoutMs 必须不少于 1000 毫秒");
  if (typeof merged.maxDownloadSize !== "string") throw new Error("maxDownloadSize 必须是带单位的体积字符串或空字符串");

  return {
    ...merged,
    author: merged.author.trim(),
    archiveDir: resolvePath(configBase, merged.archiveDir),
    downloadDir: merged.downloadDir.trim() ? resolvePath(configBase, merged.downloadDir) : "",
    outputDir: resolvePath(configBase, merged.outputDir),
    proxyUrl: merged.proxyUrl.trim(),
    maxDownloadSize: merged.maxDownloadSize.trim(),
    maxDownloadSizeBytes: merged.maxDownloadSize.trim() ? parseFileSize(merged.maxDownloadSize) : undefined,
    sevenZipPath: looksLikePath(merged.sevenZipPath) ? resolvePath(configBase, merged.sevenZipPath) : merged.sevenZipPath,
  };
}

export function validateOutputDirectory(config: Config): void {
  const outputDir = resolve(config.outputDir);
  const workingDirectory = resolve(".");
  if (dirname(outputDir) === outputDir) throw new Error("outputDir 不能是磁盘根目录");
  if (outputDir === workingDirectory || containsPath(outputDir, workingDirectory)) throw new Error("outputDir 不能是项目目录或其上级目录");
  if (containsPath(outputDir, config.archiveDir)) throw new Error("outputDir 不能等于或包含 archiveDir");
  if (config.downloadDir && containsPath(outputDir, config.downloadDir)) throw new Error("outputDir 不能等于或包含 downloadDir");
}

export async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
    if (!(await stat(path)).isDirectory()) throw new Error("路径存在但不是文件夹");
  } catch (error) {
    throw new Error(`无法创建或使用 ${label}（${path}）：${errorMessage(error)}`);
  }
}

export async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("路径存在但不是文件夹");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} 不存在：${path}，请指定已有的待扫描目录`);
    }
    throw new Error(`无法使用 ${label}（${path}）：${errorMessage(error)}`);
  }
}
