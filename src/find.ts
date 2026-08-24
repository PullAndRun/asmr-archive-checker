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
      console.log(`find complete: ${report.queue.length} works queued`);
      if (report.errors.length > 0 || report.skippedAuthors.length > 0) process.exitCode = 2;
    }
  } catch (error) {
    console.error(`find failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
