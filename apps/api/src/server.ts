import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { enableWal } from "./lib/prisma.js";
import { startRetentionSweep } from "./services/task-cleanup.service.js";

/**
 * The listen entrypoint. The only file in `src/` that binds a port — `app.ts`
 * stays a pure factory so supertest can import it.
 *
 * `PORT` and `HOST` come from `lib/env.ts`, the single `process.env` reader.
 * `HOST` defaults to `0.0.0.0` in code because that is what the container
 * needs; `env.example` ships `127.0.0.1`, because this app has no
 * authentication and binding every interface on a laptop publishes task CRUD
 * to the LAN.
 */

/**
 * Exit after giving the log line a chance to flush.
 *
 * `process.stderr.write` is asynchronous when stderr is a pipe — which is
 * exactly what Docker and CI give it — so calling `process.exit()` on the next
 * statement truncates the one line that explains why the process died.
 */
const exit = (code: number): void => {
  setImmediate(() => process.exit(code));
};

// Before accepting traffic: readers must not queue behind the writer.
await enableWal();

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info("API listening", {
    host: env.HOST,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    docsEnabled: env.DOCS_ENABLED,
  });
});

// Deletes tasks that have been done for longer than DONE_RETENTION_DAYS. Lives
// here rather than in `createApp()` so tests and the seed never start a timer.
const stopRetentionSweep = startRetentionSweep();

/**
 * Docker sends `SIGTERM` and waits ~10s before `SIGKILL`. Stop accepting
 * connections, let in-flight requests finish, then exit — otherwise a deploy
 * truncates whatever was mid-flight.
 */
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals): void => {
  // Ctrl-C twice in dev, or SIGINT arriving after SIGTERM, would otherwise arm a
  // second timer and call close() again — the second callback gets
  // ERR_SERVER_NOT_RUNNING and reports a clean shutdown as a failure.
  if (shuttingDown) {
    logger.warn("Shutdown already in progress", { signal });
    return;
  }
  shuttingDown = true;

  logger.info("Shutting down", { signal });
  stopRetentionSweep();

  const forceExit = setTimeout(() => {
    logger.warn("Forcing exit — connections did not close in time");
    exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error("Error while closing the server", { err });
      exit(1);
      return;
    }
    exit(0);
  });

  // close() stops new connections but leaves idle keep-alive sockets open, and
  // a browser tab or the Vite proxy holds one indefinitely. Without this the
  // callback waits out the full 10s timer and a clean SIGTERM exits 1 — past
  // Docker's SIGKILL window.
  server.closeIdleConnections();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/**
 * A rejection nobody handled is a bug, not a state to keep serving from. Log it
 * loudly and let the supervisor restart the process.
 */
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { err: reason });
  exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { err });
  exit(1);
});

export { server };
