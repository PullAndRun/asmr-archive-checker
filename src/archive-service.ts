import { readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { API_BASE_URL } from "./constants.ts";
import { fetchJson, fetchWorkByCode } from "./api.ts";
import { findMissingFiles, flattenTrackTree, parseSevenZipListing, type ArchiveEntry, type TrackNode } from "./domain/archive.ts";
import { workCodeFromArchiveName, type WorkCode } from "./domain/work-code.ts";
import { errorMessage } from "./shared.ts";
import type { CodedLocalWork, IncompleteArchive, LocalWork } from "./domain/records.ts";
import type { Config, RequestThrottle } from "./types.ts";

export async function findArchives(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directories = pending.splice(-32);
    const batches = await Promise.all(directories.map(async (directory) => ({
      directory,
      entries: await readdir(directory, { withFileTypes: true }),
    })));
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && extname(entry.name).toLowerCase() === ".7z") found.push(resolve(path));
      }
    }
  }
  return found.toSorted((left, right) => left.localeCompare(right));
}

export async function findDownloadedWorkFolders(root: string): Promise<LocalWork[]> {
  const found: LocalWork[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directories = pending.splice(-32);
    const batches = await Promise.all(directories.map(async (directory) => {
      try {
        return { directory, entries: await readdir(directory, { withFileTypes: true }) };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return { directory, entries: [] };
        throw error;
      }
    }));
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".asmr-archive-checker-downloads") continue;
        const path = join(directory, entry.name);
        if (/^(?:RJ|BJ)\d+$/i.test(entry.name)) {
          const workCode = workCodeFromArchiveName(`${entry.name}.7z`);
          if (workCode) found.push({ path: resolve(path), workCode });
        } else {
          pending.push(path);
        }
      }
    }
  }
  return found.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function classifyArchives(paths: string[]): { recognized: CodedLocalWork[]; unknown: string[] } {
  const recognized: CodedLocalWork[] = [];
  const unknown: string[] = [];
  for (const path of paths) {
    const workCode = workCodeFromArchiveName(path);
    if (workCode) recognized.push({ path, workCode });
    else unknown.push(path);
  }
  return { recognized, unknown };
}

export async function listArchive(path: string, sevenZipPath: string, timeoutMs = 300_000): Promise<ArchiveEntry[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`7-Zip 超时必须不少于 1000 毫秒，实际为 ${timeoutMs}`);
  }
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn([sevenZipPath, "l", "-slt", "-sccUTF-8", "--", path], {
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
  } catch (error) {
    throw new Error(`无法启动 7-Zip（${sevenZipPath}）：${errorMessage(error)}`);
  }
  if (!(process.stdout instanceof ReadableStream) || !(process.stderr instanceof ReadableStream)) {
    throw new Error("7-Zip 子进程未提供可读的输出流");
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill();
    } catch {
      // The process may have exited between the timeout and the kill call.
    }
  }, timeoutMs);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
  } catch (error) {
    try {
      process.kill();
      await process.exited;
    } catch {
      // Preserve the original stream/process error.
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error(`7-Zip 列出文件超时（${timeoutMs} 毫秒）：${path}`);
  if (exitCode !== 0) throw new Error(`7-Zip 返回代码 ${exitCode}：${stderr.trim() || stdout.trim()}`);
  return parseSevenZipListing(stdout);
}

export async function checkArchive(
  archivePath: string,
  workCode: WorkCode,
  config: Config,
  knownWorkId?: number,
  proxyUrl = "",
  throttle?: RequestThrottle,
): Promise<IncompleteArchive | undefined> {
  let workId = knownWorkId;
  try {
    if (workId === undefined) workId = (await fetchWorkByCode(workCode, config, proxyUrl, throttle)).id;
    const [archiveResult, trackResult] = await Promise.allSettled([
      listArchive(archivePath, config.sevenZipPath, config.archiveTimeoutMs),
      fetchJson<TrackNode[]>(`${API_BASE_URL}/api/tracks/${workId}?v=2`, config.requestTimeoutMs, 4, proxyUrl, throttle),
    ]);
    if (archiveResult.status === "rejected" || trackResult.status === "rejected") {
      const failures = [archiveResult, trackResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => errorMessage(result.reason));
      throw new Error(failures.join("；"));
    }
    const archiveEntries = archiveResult.value;
    const trackTree = trackResult.value;
    if (!Array.isArray(trackTree)) throw new Error("文件列表 API 返回了无法识别的数据结构");
    const expectedPaths = flattenTrackTree(trackTree);
    if (expectedPaths.length === 0) throw new Error("网站文件列表为空，无法判断完整性");
    const missingFiles = findMissingFiles(archiveEntries, expectedPaths, workCode);
    return missingFiles.length > 0 ? { archivePath, workCode, workId, missingFiles } : undefined;
  } catch (error) {
    return { archivePath, workCode, workId, missingFiles: [], error: errorMessage(error) };
  }
}

export const archiveLabel = (work: LocalWork): string => basename(work.path);
