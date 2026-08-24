import type { NonAuthorWork } from "./domain/records.ts";
import type { WorkCode, WorkReference } from "./domain/work-code.ts";

export type Config = {
  author: string;
  archiveDir: string;
  asmrDir: string;
  downloadDir: string;
  outputDir: string;
  sevenZipPath: string;
  concurrency: number;
  maxWorkers: number;
  maxRetries: number;
  proxyUrl: string;
  apiUrls?: string[];
  syncQps: number;
  requestTimeoutMs: number;
  archiveTimeoutMs?: number;
  maxDownloadSize: string;
  maxDownloadSizeBytes?: number;
};

export type Mode = "author" | "archives" | "delete" | "delete-non-author" | "download" | "find";

export type CliOptions = {
  mode: Mode;
  configPath?: string;
  author?: string;
  archiveDir?: string;
  asmrDir?: string;
  outputDir?: string;
  downloadDir?: string;
  sevenZipPath?: string;
  concurrency?: number;
  maxDownloadSize?: string;
  help: boolean;
};

export type SearchWork = {
  id: number;
  title?: string;
  release?: string;
  source_id?: string;
  source_type?: string;
};

export type SearchResponse = {
  works: SearchWork[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalCount: number;
  };
};

export type RequestThrottle = () => Promise<void>;

export type NonAuthorDeletionCandidate = NonAuthorWork & { size: number };
export type NonAuthorDeletionFailure = { path: string; error: string };
export type DeletionCandidate = WorkReference & { archivePath: string; size: number };
export type DeletionFailure = { archivePath: string; error: string };

export type DownloadResult = {
  workId: number;
  displayId: string;
  status: "downloaded" | "skipped" | "unavailable" | "failed";
  targetPath?: string;
  stagingPath?: string;
  size?: number;
  error?: string;
  retryAfterMinutes?: number;
  retryAfterAt?: string;
};

export type DownloadTarget = { workId: number; displayId: string; author?: string };

export type DownloadBatchResult = {
  results: DownloadResult[];
  downloadedSize: number;
  stoppedByLimit: boolean;
  stoppedByServiceUnavailable: boolean;
  remainingCount: number;
};
