import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dbFileUrl, testDbPath } from "../../vitest.globalSetup.js";
import { prisma } from "../lib/prisma.js";
import { makeComment, makeTicket, makeTickets } from "./factories.js";

/**
 * Tests for the test harness itself.
 *
 * Everything asserted here is a property stages 6–8 will rely on without
 * thinking about it: that writes go to a temp file, that each test starts empty,
 * and that the builders produce rows the query layer can sort. When one of these
 * breaks, hundreds of unrelated tests break in confusing ways — so they get
 * their own assertions rather than being implied by other tests passing.
 */

/**
 * Opt-in trace used to prove parallelism by hand (see the stage 5 gate). Off in
 * normal runs: a test that writes to a shared file on every run is a race
 * waiting to happen.
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

describe("database isolation", () => {
  it("points DATABASE_URL at a per-worker file in the OS temp directory", () => {
    traceWorker("harness.test.ts");

    const url = process.env.DATABASE_URL ?? "";

    // Built from the same helpers the setup file uses, not from a second copy of
    // the naming convention. Restating it here means that if the worker id is
    // ever unset (a pool change, --no-file-parallelism), setup falls back to "1"
    // while the assertion expects "undefined" — and the one test people trust
    // fails while isolation is in fact working.
    expect(url).toBe(dbFileUrl(testDbPath(process.env.VITEST_WORKER_ID ?? "1")));
    expect(url).toContain(os.tmpdir());
    expect(url).not.toContain("prisma/data");
  });

  it("starts each test with an empty database", async () => {
    // This test only means something next to the one below, which fills it.
    expect(await prisma.ticket.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
  });

  it("leaves rows behind for the truncation above to clear", async () => {
    const ticket = await makeTicket();
    await makeComment({ ticketId: ticket.id });

    expect(await prisma.ticket.count()).toBe(1);
    expect(await prisma.comment.count()).toBe(1);
  });

  it("restarts autoincrement ids from 1 in every test", async () => {
    const ticket = await makeTicket();
    expect(ticket.id).toBe(1);
  });
});

describe("factories", () => {
  it("defaults a ticket to open/medium with matching rank columns", async () => {
    const ticket = await makeTicket();

    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("medium");
    expect(ticket.statusRank).toBe(0);
    expect(ticket.priorityRank).toBe(1);
    expect(ticket.resolvedAt).toBeNull();
  });

  it("derives rank columns from an overridden status and priority", async () => {
    const ticket = await makeTicket({ status: "closed", priority: "urgent" });

    expect(ticket.statusRank).toBe(3);
    expect(ticket.priorityRank).toBe(3);
    // A closed fixture carries the timestamps its own invariants require.
    expect(ticket.resolvedAt).not.toBeNull();
    expect(ticket.closedAt).not.toBeNull();
  });

  it("sorts by severity rather than alphabetically when ordered by priorityRank", async () => {
    await makeTicket({ priority: "high" });
    await makeTicket({ priority: "urgent" });
    await makeTicket({ priority: "low" });

    const ordered = await prisma.ticket.findMany({ orderBy: { priorityRank: "desc" } });

    expect(ordered.map((t) => t.priority)).toEqual(["urgent", "high", "low"]);
  });

  it("creates tickets in id order, with per-index overrides", async () => {
    const tickets = await makeTickets(3, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));

    expect(tickets.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(tickets.map((t) => t.createdAt.toISOString())).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });
});

/**
 * The "throwaway service test" from the stage 5 gate, kept because it is what
 * proves the harness can support stage 6 at all: a real write, a real read back
 * through a relation, and a real cascade — no HTTP, no service layer (there is
 * none yet), just the seam those will sit on.
 */
describe("a service-shaped round trip", () => {
  it("writes a ticket with comments and cascades the delete", async () => {
    const ticket = await makeTicket({ status: "in_progress", assignee: "Dana Ruiz" });
    await makeComment({ ticketId: ticket.id, body: "first" });
    await makeComment({ ticketId: ticket.id, body: "second" });

    const loaded = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { comments: { orderBy: { id: "asc" } } },
    });

    expect(loaded?.assignee).toBe("Dana Ruiz");
    expect(loaded?.comments.map((c) => c.body)).toEqual(["first", "second"]);

    await prisma.ticket.delete({ where: { id: ticket.id } });

    expect(await prisma.comment.count()).toBe(0);
  });
});
