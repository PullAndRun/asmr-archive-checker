export * from "./api.ts";
export * from "./application.ts";
export * from "./archive-service.ts";
export * from "./config.ts";
export * from "./deletion.ts";
export * from "./domain/archive.ts";
export * from "./domain/records.ts";
export * from "./domain/size.ts";
export * from "./domain/work-code.ts";
export * from "./downloader.ts";
export * from "./logger.ts";
export * from "./http.ts";
export * from "./results-store.ts";
export type * from "./types.ts";

import { main } from "./application.ts";
import { usage } from "./config.ts";
import { logger } from "./logger.ts";
import { errorMessage } from "./shared.ts";

if (import.meta.main) {
  main().catch((error) => {
    logger.error(`错误：${errorMessage(error)}`);
    logger.error(usage());
    process.exitCode = 1;
  });
}
