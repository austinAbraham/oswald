/**
 * Tiny, dependency-free logger with consistent prefixes.
 *
 * Writes informational/success output to stdout and warn/error to stderr so
 * that machine-readable output (if any) can be separated from diagnostics.
 */

export type LogLevel = "info" | "warn" | "error" | "success";

const PREFIX: Record<LogLevel, string> = {
  info: "[oswald]",
  warn: "[oswald:warn]",
  error: "[oswald:error]",
  success: "[oswald:ok]",
};

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
}

export interface LoggerOptions {
  /** Sink for info/success output. Defaults to console.log. */
  out?: (line: string) => void;
  /** Sink for warn/error output. Defaults to console.error. */
  err?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  const fmt = (level: LogLevel, message: string): string =>
    `${PREFIX[level]} ${message}`;

  return {
    info: (message) => out(fmt("info", message)),
    success: (message) => out(fmt("success", message)),
    warn: (message) => err(fmt("warn", message)),
    error: (message) => err(fmt("error", message)),
  };
}

/** Default logger writing to the real console. */
export const logger: Logger = createLogger();
