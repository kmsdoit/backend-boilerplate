import { applicationConfig } from "@app/config";

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const consoleFor: Record<LogLevel, (...args: unknown[]) => void> = {
  info: console.log,
  warn: console.warn,
  error: console.error,
};

/**
 * Structured, dependency-free logging. Today's requirement is "one JSON line
 * per log call", which JSON.stringify already gets us -- swapping in pino or
 * similar later is a one-file change because every caller goes through this
 * module rather than through `console` directly.
 *
 * JSON in `test` and `production`, so CI exercises the exact code path
 * production runs and lines stay machine-parseable. `development` gets a
 * human-readable one-liner, since a terminal is the only place that output is
 * read by a person.
 *
 * Reads applicationConfig, NOT process.env.NODE_ENV: nothing in this repo's
 * dev script sets NODE_ENV, so branching on it directly would silently give
 * local development the JSON format.
 */
function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const time = new Date().toISOString();
  const write = consoleFor[level];

  if (applicationConfig.application.environment === "development") {
    const extra = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    write(`${time} [${level.toUpperCase()}] ${message}${extra}`);
    return;
  }

  write(
    JSON.stringify({
      time,
      level,
      service: applicationConfig.application.name,
      message,
      ...fields,
    }),
  );
}

export const logger = {
  log: emit,
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
