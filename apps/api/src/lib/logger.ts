import { env } from "./env.js";

/**
 * A very small structured logger.
 *
 * Deliberately not pino/winston: the only consumers are the error handler and
 * `server.ts`, and a dependency-free logger keeps the runtime image smaller and
 * the output trivially greppable. One JSON object per line, so `requestId`
 * correlates a 500 response with its stack without a log aggregator.
 *
 * `console` is not used because the repo lint config restricts it (and because
 * `console.log` interleaves badly under load). Levels below `LOG_LEVEL` are
 * dropped; `warn` and `error` go to stderr, everything else to stdout.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold = LEVEL_WEIGHT[env.LOG_LEVEL];

/** Extra structured fields attached to a line. Never put secrets in here. */
export type LogFields = Record<string, unknown>;

/**
 * `Error` has non-enumerable `message`/`stack`, so `JSON.stringify` renders it
 * as `{}`. Anything that looks like an error is flattened explicitly.
 */
const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
};

const write = (level: LogLevel, message: string, fields?: LogFields): void => {
  if (LEVEL_WEIGHT[level] < threshold) return;

  const line = { level, time: new Date().toISOString(), message, ...fields };

  let serialized: string;
  try {
    serialized = JSON.stringify(line, replacer);
  } catch {
    // A circular structure in `fields` must never take the process down —
    // logging is the thing that is supposed to still work when nothing else does.
    serialized = JSON.stringify({ level, time: line.time, message, fieldsUnserializable: true });
  }

  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${serialized}\n`);
};

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};

export type Logger = typeof logger;
