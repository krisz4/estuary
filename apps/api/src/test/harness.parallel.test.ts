import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeComment, makeTickets } from "./factories.js";

/**
 * The second half of the parallelism proof. It exists to be *another file* that
 * hammers the database at the same time as `harness.test.ts`, because that is
 * the arrangement that deadlocks when the harness gets it wrong: SQLite takes
 * one writer, and a shared file across parallel workers means `SQLITE_BUSY`
 * (or a hang) rather than a clean failure.
 *
 * Deliberately write-heavy and slow-ish, so the overlap is real rather than
 * theoretical.
 */

const traceWorker = (file: string): void => {
  if (process.env.HARNESS_WORKER_TRACE !== "true") return;
  appendFileSync(
    path.join(os.tmpdir(), "helpdesk-harness-trace.log"),
    `${JSON.stringify({
      file,
      pid: process.pid,
      workerId: process.env.VITEST_WORKER_ID,
      databaseUrl: process.env.DATABASE_URL,
      at: new Date().toISOString(),
    })}\n`,
  );
};

describe("concurrent write load from a second test file", () => {
  it("completes a burst of writes without contending with the other file", async () => {
    traceWorker("harness.parallel.test.ts");

    const tickets = await makeTickets(40, (index) => ({
      title: `Parallel ticket ${index}`,
      status: index % 2 === 0 ? "open" : "in_progress",
    }));

    for (const ticket of tickets.slice(0, 10)) {
      await makeComment({ ticketId: ticket.id });
    }

    expect(await prisma.ticket.count()).toBe(40);
    expect(await prisma.comment.count()).toBe(10);
  });

  it("sees none of the other file's rows, because the database is per worker", async () => {
    traceWorker("harness.parallel.test.ts");

    // `harness.test.ts` leaves a "Test ticket 1" behind in several of its tests.
    // Even in the same worker, truncation means this file never observes them.
    expect(await prisma.ticket.count()).toBe(0);
  });
});
