import { PrismaClient, type Prisma } from "@prisma/client";

import { env } from "./env.js";

/**
 * The single Prisma client for the process.
 *
 * **It is constructed at import time**, from `DATABASE_URL` as parsed by
 * `lib/env.ts`. That is deliberate, and it has one consequence worth stating
 * loudly because it is the kind of thing that eats a developer's local data:
 *
 * > By the time any test hook runs, this module has already been imported and
 * > the client is already bound to whatever `DATABASE_URL` said. Tests must
 * > therefore set `DATABASE_URL` in a vitest `setupFiles` entry — which runs
 * > *before* test modules are imported — and never in a `beforeAll`.
 *
 * See `docs/engineering/TESTING.md`.
 */
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});

export type { PrismaClient };

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * The only way a service opens an **interactive write transaction.**
 *
 * SQLite allows one writer at a time, and Prisma starts its interactive
 * transactions as deferred (`BEGIN`), which take a shared lock on the first
 * read and try to upgrade on the first write. Two of them that have both read
 * cannot both upgrade: SQLite refuses one, the other waits on it, and the pair
 * ends as a "Socket timeout" 500 after the busy timeout. Measured, not assumed:
 * 15 concurrent `POST /tasks` produced 9 of those before this existed.
 *
 * So writes queue **in process**, one transaction at a time. That costs nothing
 * SQLite was not already going to charge — it serializes writers regardless —
 * and it turns a deadlock into a short wait. It holds because the API is a
 * single process per database file, which is how it is built and deployed; a
 * second process writing the same file would need `BEGIN IMMEDIATE` instead,
 * which Prisma does not expose.
 *
 * Reads never take this lock and never need an interactive transaction:
 * `listTasks` uses the batch form, which runs as one statement sequence.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function writeTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const run = writeQueue.then(() => prisma.$transaction(fn));
  // The queue must survive a failed transaction, or one 409 would wedge every
  // write after it.
  writeQueue = run.catch(() => undefined);
  return run;
}

/**
 * WAL lets readers proceed while a write is in flight, instead of every poll
 * from the board and every agent's `GET` waiting on the writer. Persisted in the
 * database file, so running it on every boot is a cheap no-op after the first.
 * `journal_mode` returns a row, hence `$queryRaw`, not `$executeRaw`.
 */
export async function enableWal(): Promise<void> {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
}
