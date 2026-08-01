import { config, createLogger, format, transports } from "winston";

const requestedLevel = process.env.LOG_LEVEL?.toLowerCase();
const level = requestedLevel && requestedLevel in config.npm.levels ? requestedLevel : "info";

export const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(({ timestamp, level: entryLevel, message }) =>
      `${timestamp} ${entryLevel.toUpperCase()} ${String(message)}`
    ),
  ),
  transports: [
    new transports.Console({
      stderrLevels: ["error"],
      consoleWarnLevels: ["warn"],
    }),
  ],
});
