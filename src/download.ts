import { loadConfig, parseArgs, usage, ensureDirectory, validateOutputDirectory } from "./config.ts";
import { join } from "node:path";
import {
  readAuthorDownloadQueue,
  removeAuthorDownloadQueueEntry,
  writeAuthorDownloadQueue,
} from "./author-sync.ts";
import { downloadWorks } from "./downloader.ts";
import { errorMessage } from "./shared.ts";
import { AUTHOR_DOWNLOAD_FAILURES_FILE_NAME } from "./constants.ts";
import { writeFileAtomically } from "./fs-utils.ts";

if (import.meta.main) {
  try {
    const cli = parseArgs(["download", ...Bun.argv.slice(2)]);
    if (cli.help) {
      console.log(usage());
    } else {
      const config = await loadConfig(cli);
      validateOutputDirectory(config);
      await ensureDirectory(config.downloadDir, "downloadDir");
      const queue = await readAuthorDownloadQueue(config);
      // downloadWorks checks the exact destination (downloadDir/author/workCode).
      // Another author's copy must not suppress this author's destination.
      let remainingQueue = queue;
      // A failed resource is skipped immediately; the next invocation retries it.
      const downloadConfig = { ...config, maxRetries: 0 };
      const result = await downloadWorks(remainingQueue.map((item) => ({
        workId: item.workId,
        displayId: item.workCode,
        author: item.author,
      })), downloadConfig, undefined, {
        retryFailedWorks: false,
        onDownloaded: async (downloaded) => {
          const nextQueue = removeAuthorDownloadQueueEntry(remainingQueue, downloaded.displayId);
          if (nextQueue.length === remainingQueue.length) return;
          await writeAuthorDownloadQueue(config, nextQueue);
          remainingQueue = nextQueue;
        },
      });
      for (const skipped of result.results.filter((item) => item.status === "skipped")) {
        const nextQueue = removeAuthorDownloadQueueEntry(remainingQueue, skipped.displayId);
        if (nextQueue.length === remainingQueue.length) continue;
        await writeAuthorDownloadQueue(config, nextQueue);
        remainingQueue = nextQueue;
      }
      const resultByCode = new Map(result.results.map((item) => [`${item.workId}\0${item.displayId}`, item]));
      const failures = queue.flatMap((item) => {
        const outcome = resultByCode.get(`${item.workId}\0${item.workCode}`);
        return outcome && (outcome.status === "failed" || outcome.status === "unavailable")
          ? [{
              author: item.author,
              workCode: item.workCode,
              workId: item.workId,
              status: outcome.status,
              error: outcome.error ?? "download failed",
              ...(outcome.retryAfterMinutes !== undefined ? { retryAfterMinutes: outcome.retryAfterMinutes } : {}),
              ...(outcome.retryAfterAt ? { retryAfterAt: outcome.retryAfterAt } : {}),
              ...(outcome.stagingPath ? { stagingPath: outcome.stagingPath } : {}),
            }]
          : [];
      });
      await ensureDirectory(config.outputDir, "outputDir");
      await writeFileAtomically(join(config.outputDir, AUTHOR_DOWNLOAD_FAILURES_FILE_NAME), `${JSON.stringify(failures, null, 2)}\n`);
      console.log(`download complete: ${result.results.filter((item) => item.status === "downloaded").length} works downloaded`);
      if (result.stoppedByRateLimit && result.remainingCount > 0) {
        console.warn(`media server rate limit reached; ${result.remainingCount} works remain. Wait for the limit window to end before retrying.`);
      }
      if (result.results.some((item) => item.status === "failed")) process.exitCode = 2;
    }
  } catch (error) {
    console.error(`download failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
