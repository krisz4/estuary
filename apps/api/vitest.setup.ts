import { copyFileSync, existsSync } from "node:fs";

import { afterAll, beforeEach } from "vitest";

import { dbFileUrl, templateDbPath, testDbPath } from "./vitest.globalSetup.js";

/**
 * Vitest **setup file** — registered as a `setupFiles` entry in
 * `vitest.config.ts`, and that registration is the whole point of it.
 *
 * `setupFiles` run *before the test module is imported*. `beforeAll` runs
 * *after*. `src/lib/prisma.ts` constructs its `PrismaClient` at import time from
 * `DATABASE_URL`, so a `beforeAll` assignment lands after the client has already
 * bound — to the developer's real database, which `beforeEach` then truncates.
 * That is the failure this file exists to make impossible; see
 * `docs/engineering/TESTING.md` § Database isolation.
 *
 * Everything below the environment assignments therefore uses `await import()`,
 * not a static import: static imports are hoisted above the assignments.
 */

/* ------------------------------------------------------------------ *
 * 1. Environment — before any application module is loaded
 * ------------------------------------------------------------------ */

/**
 * Vitest sets `NODE_ENV=test` only when it is unset. A developer with
 * `NODE_ENV=development` exported in their shell would otherwise lose the
 * `/__test__/boom` diagnostic routes (`app.ts` mounts them only under `test`)
 * and see four stage-4 assertions fail for no visible reason. `test.env` in the
 * config pins it too; this is the assignment that cannot be skipped.
 */
process.env.NODE_ENV = "test";

const workerId = process.env.VITEST_WORKER_ID ?? "1";
const dbPath = testDbPath(workerId);

/**
 * The first test file to run in a worker copies the migrated template; the rest
 * reuse it and are separated by the `beforeEach` truncation below. Copying is
 * per worker rather than per file because vitest reuses worker processes, and
 * re-migrating for every file would dominate the suite's wall time.
 */
if (!existsSync(dbPath)) copyFileSync(templateDbPath(), dbPath);

process.env.DATABASE_URL = dbFileUrl(dbPath);

/* ------------------------------------------------------------------ *
 * 2. Application modules — only now
 * ------------------------------------------------------------------ */

const { env } = await import("./src/lib/env.js");
const { prisma } = await import("./src/lib/prisma.js");

/**
 * The guard that matters, and it has to be **here** — after the import.
 *
 * Asserting on `process.env.DATABASE_URL` a line below assigning it is
 * `x.startsWith(x)`: always true, protecting nothing. What can actually go
 * wrong lives downstream, in `lib/env.ts` — a `.env` loader precedence change,
 * or a static import hoisted above the assignment above. So check the value the
 * application layer actually resolved, before `beforeEach` is allowed to
 * truncate whatever it points at.
 */
if (env.DATABASE_URL !== dbFileUrl(dbPath)) {
  throw new Error(
    `Refusing to run: lib/env.ts resolved DATABASE_URL to ${env.DATABASE_URL}, ` +
      `not this worker's temp file ${dbFileUrl(dbPath)}. The next truncation would ` +
      `have run against that database.`,
  );
}

/* ------------------------------------------------------------------ *
 * 3. Per-test truncation
 * ------------------------------------------------------------------ */

/**
 * Truncate rather than re-copy: one transaction beats a file copy plus a new
 * client per test. `sqlite_sequence` is reset too, so ids start from 1 in every
 * test and a test that needs a specific reference (`HD-000042`) can arrange it.
 *
 * `Comment` first, then `Ticket`: the cascade would handle it, but relying on
 * the cascade to clean up would hide a broken cascade from the test that checks it.
 */
beforeEach(async () => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe('DELETE FROM "Comment"'),
    prisma.$executeRawUnsafe('DELETE FROM "Ticket"'),
    prisma.$executeRawUnsafe(`DELETE FROM sqlite_sequence WHERE name IN ('Ticket', 'Comment')`),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ *
 * 4. Expected-stderr filter
 * ------------------------------------------------------------------ */

/**
 * The forced-500 tests hit `/__test__/boom`, and a 500 **must** log its stack —
 * that is the error contract working. It is also two screens of JSON in the
 * middle of an otherwise clean run, which trains people to ignore stderr.
 *
 * So: drop a line only when it is our logger's "Unhandled error" for a
 * `/__test__/` path. A 500 from any real route, an unhandled rejection, a vitest
 * diagnostic, or anything that is not this exact shape still prints.
 */
const DIAGNOSTIC_PATH_PREFIX = "/__test__/";

const isExpectedDiagnosticLog = (chunk: unknown): boolean => {
  const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : null;
  if (text === null) return false;

  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;

  return lines.every((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;

    const { level, message, path: requestPath } = parsed as Record<string, unknown>;
    return (
      level === "error" &&
      message === "Unhandled error" &&
      typeof requestPath === "string" &&
      requestPath.startsWith(DIAGNOSTIC_PATH_PREFIX)
    );
  });
};

const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stderr.write = ((
  chunk: string | Uint8Array,
  encoding?: unknown,
  callback?: unknown,
): boolean => {
  if (isExpectedDiagnosticLog(chunk)) {
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  }
  return (originalStderrWrite as (...args: unknown[]) => boolean)(chunk, encoding, callback);
}) as typeof process.stderr.write;

afterAll(() => {
  process.stderr.write = originalStderrWrite;
});
