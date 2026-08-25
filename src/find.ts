import { loadConfig, parseArgs, usage } from "./config.ts";
import { runAuthorFind } from "./author-sync.ts";
import { errorMessage } from "./shared.ts";

if (import.meta.main) {
  try {
    const cli = parseArgs(["find", ...Bun.argv.slice(2)]);
    if (cli.help) {
      console.log(usage());
    } else {
      const report = await runAuthorFind(await loadConfig(cli));
      const incompleteCount = report.queue.filter((item) => item.reason === "incomplete").length;
      const missingCount = report.queue.length - incompleteCount;
      console.log(
        `find complete: ${report.queue.length} works queued ` +
        `(${incompleteCount} incomplete 7z, ${missingCount} missing works)`,
      );
      if (report.errors.length > 0 || report.skippedAuthors.length > 0) process.exitCode = 2;
    }
  } catch (error) {
    console.error(`find failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
