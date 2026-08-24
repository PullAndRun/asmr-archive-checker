import { readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequestThrottle, fetchWorksForAuthor, workCodeFromSearchWork } from "./api.ts";
import { checkArchive, classifyArchives, findDownloadedWorkFolders, findArchives } from "./archive-service.ts";
import { AUTHOR_DOWNLOAD_QUEUE_FILE_NAME, AUTHOR_FIND_REPORT_FILE_NAME, AUTHOR_SKIPPED_FILE_NAME } from "./constants.ts";
import { type IncompleteArchive } from "./domain/records.ts";
import { normalizeWorkCode, workCodeOf, type WorkCode } from "./domain/work-code.ts";
import { ensureDirectory, requireDirectory, validateOutputDirectory } from "./config.ts";
import { mapLimit, errorMessage } from "./shared.ts";
import { logger } from "./logger.ts";
import { findHttpResponseError } from "./http.ts";
import type { Config, SearchWork } from "./types.ts";

export type AuthorQueueItem = {
  author: string;
  workCode: WorkCode;
  workId: number;
  reason: "missing" | "incomplete";
  source: string;
  missingFiles?: string[];
};

export type AuthorFindReport = {
  version: 1;
  generatedAt: string;
  authors: Array<{ author: string; totalWorks: number; assignedWorks: number }>;
  missing: AuthorQueueItem[];
  incomplete: Array<IncompleteArchive & { author: string }>;
  queue: AuthorQueueItem[];
  skippedAuthors: Array<{ author: string; error: string; retryAfterMinutes?: number; retryAfterAt?: string }>;
  errors: Array<{ author: string; error: string }>;
};

type AuthorInfo = { name: string; path: string; works: SearchWork[] };

async function listAuthors(root: string): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !/^[A-Z]J\d+$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, path: resolve(join(root, entry.name)) }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

const keyOf = (value: string): string => value.toLowerCase();

export async function findAuthorDownloads(config: Config): Promise<AuthorFindReport> {
  validateOutputDirectory(config);
  await requireDirectory(config.asmrDir, "asmrDir");
  const authors = await listAuthors(config.asmrDir);
  if (authors.length === 0) throw new Error("asmrDir does not contain any author directories");
  const throttle = createRequestThrottle(config.syncQps);
  const errors: Array<{ author: string; error: string }> = [];
  const skippedAuthors: AuthorFindReport["skippedAuthors"] = [];
  const authorInfos: AuthorInfo[] = [];
  const fetched = await mapLimit(authors, config.concurrency, async (author) => {
    try {
      const works = await fetchWorksForAuthor(author.name, config, throttle);
      if (works.length === 0) {
        const message = "API returned no works for this author";
        skippedAuthors.push({ author: author.name, error: message });
        logger.warn(`Author skipped: ${author.name}: ${message}`);
        return undefined;
      }
      logger.info(`Author complete: ${author.name} (${works.length} works)`);
      return { ...author, works };
    } catch (error) {
      const message = errorMessage(error);
      const responseError = findHttpResponseError(error);
      const retryAfterMinutes = responseError?.retryAfterTotalMs === undefined
        ? undefined
        : Math.round(responseError.retryAfterTotalMs / 60_000 * 100) / 100;
      skippedAuthors.push({
        author: author.name,
        error: message,
        ...(retryAfterMinutes !== undefined ? { retryAfterMinutes } : {}),
        ...(responseError?.retryAfterAt ? { retryAfterAt: responseError.retryAfterAt } : {}),
      });
      logger.warn(`Author skipped: ${author.name}: ${message}${retryAfterMinutes !== undefined ? `; retry after about ${retryAfterMinutes} minutes` : ""}`);
      return undefined;
    }
  });
  authorInfos.push(...fetched.filter((author): author is AuthorInfo => author !== undefined));

  const candidates = new Map<string, Array<{ author: AuthorInfo; work: SearchWork }>>();
  for (const author of authorInfos) {
    for (const work of author.works) {
      let code: WorkCode;
      try {
        code = workCodeFromSearchWork(work);
      } catch (error) {
        errors.push({ author: author.name, error: errorMessage(error) });
        continue;
      }
      const list = candidates.get(keyOf(code)) ?? [];
      list.push({ author, work });
      candidates.set(keyOf(code), list);
    }
  }

  // Duplicate works are assigned to the author with the larger catalogue.
  const assigned = new Map<string, { author: AuthorInfo; work: SearchWork }>();
  for (const [code, entries] of candidates) {
    entries.sort((left, right) => right.author.works.length - left.author.works.length || left.author.name.localeCompare(right.author.name));
    assigned.set(code, entries[0]);
  }

  const scanRoots = [config.asmrDir, ...(config.downloadDir ? [config.downloadDir] : [])];
  const localScans = await Promise.all(scanRoots.map(async (root) => {
    try {
      const [archives, folders] = await Promise.all([findArchives(root), findDownloadedWorkFolders(root)]);
      return { archives, folders };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { archives: [], folders: [] };
      throw error;
    }
  }));
  const archivePaths = [...new Set(localScans.flatMap((scan) => scan.archives))];
  const folderCodes = new Set(localScans.flatMap((scan) => scan.folders.map((folder) => keyOf(workCodeOf(folder)))));
  const recognized = classifyArchives(archivePaths).recognized;
  const archiveResults = await mapLimit(recognized, config.concurrency, async (archive) => {
    const match = assigned.get(keyOf(archive.workCode));
    if (!match) return { archive, result: undefined };
    return {
      archive,
      result: await checkArchive(archive.path, archive.workCode, config, match.work.id, throttle),
    };
  });
  const incompleteCodes = new Set<string>();
  const incomplete: Array<IncompleteArchive & { author: string }> = [];
  for (const item of archiveResults) {
    if (!item.result) continue;
    const match = assigned.get(keyOf(item.archive.workCode));
    if (!match) continue;
    const result = item.result;
    incomplete.push({ ...result, author: match.author.name });
    if (result.missingFiles.length > 0 && !result.error) incompleteCodes.add(keyOf(workCodeOf(result)));
  }
  const completeCodes = new Set([...folderCodes]);
  for (const item of archiveResults) {
    if (!item.result && assigned.has(keyOf(item.archive.workCode))) completeCodes.add(keyOf(item.archive.workCode));
  }

  const missing: AuthorQueueItem[] = [];
  for (const [code, match] of assigned) {
    if (completeCodes.has(code) || incompleteCodes.has(code)) continue;
    missing.push({
      author: match.author.name,
      workCode: workCodeFromSearchWork(match.work),
      workId: match.work.id,
      reason: "missing",
      source: typeof match.work.title === "string" ? match.work.title : "website search",
    });
  }
  const incompleteQueue: AuthorQueueItem[] = incomplete
    .filter((item) => item.missingFiles.length > 0 && !item.error)
    .flatMap((item) => {
      const itemCode = workCodeOf(item);
      const match = assigned.get(keyOf(itemCode));
      return match ? [{
        author: match.author.name,
        workCode: workCodeFromSearchWork(match.work),
        workId: match.work.id,
        reason: "incomplete" as const,
        source: item.archivePath,
        missingFiles: item.missingFiles,
      }] : [];
    });
  const queue = [...new Map([...incompleteQueue, ...missing].map((item) => [keyOf(item.workCode), item])).values()]
    .toSorted((left, right) => left.author.localeCompare(right.author) || left.workCode.localeCompare(right.workCode));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    authors: authorInfos.map((author) => ({
      author: author.name,
      totalWorks: author.works.length,
      assignedWorks: [...assigned.values()].filter((entry) => entry.author === author).length,
    })),
    missing,
    incomplete,
    queue,
    skippedAuthors,
    errors,
  };
}

export async function writeAuthorFindResults(config: Config, report: AuthorFindReport): Promise<void> {
  await ensureDirectory(config.outputDir, "outputDir");
  await Promise.all([
    Bun.write(join(config.outputDir, AUTHOR_FIND_REPORT_FILE_NAME), `${JSON.stringify(report, null, 2)}\n`),
    Bun.write(join(config.outputDir, AUTHOR_DOWNLOAD_QUEUE_FILE_NAME), `${JSON.stringify(report.queue, null, 2)}\n`),
    Bun.write(join(config.outputDir, AUTHOR_SKIPPED_FILE_NAME), `${JSON.stringify(report.skippedAuthors, null, 2)}\n`),
  ]);
}

export async function readAuthorDownloadQueue(config: Config): Promise<AuthorQueueItem[]> {
  const file = Bun.file(join(config.outputDir, AUTHOR_DOWNLOAD_QUEUE_FILE_NAME));
  if (!(await file.exists())) throw new Error(`Missing ${AUTHOR_DOWNLOAD_QUEUE_FILE_NAME}; run find first`);
  const value: unknown = await file.json();
  if (!Array.isArray(value)) throw new Error("Author download queue must be a JSON array");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid author download queue item");
    const record = item as Partial<AuthorQueueItem>;
    const normalizedCode = typeof record.workCode === "string" ? normalizeWorkCode(record.workCode) : undefined;
    const workId = record.workId;
    if (!record.author?.trim() || !normalizedCode || typeof workId !== "number" || !Number.isSafeInteger(workId) || workId < 1 ||
      (record.reason !== "missing" && record.reason !== "incomplete") || typeof record.source !== "string") {
      throw new Error("Invalid author download queue item");
    }
    return { ...record, author: record.author.trim(), workCode: normalizedCode, workId } as AuthorQueueItem;
  });
}

export async function runAuthorFind(config: Config): Promise<AuthorFindReport> {
  const report = await findAuthorDownloads(config);
  await writeAuthorFindResults(config, report);
  return report;
}
