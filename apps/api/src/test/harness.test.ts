import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dbFileUrl, testDbPath } from "../../vitest.globalSetup.js";
import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  expiredClaimBy,
  makeComment,
  makeDecision,
  makeDependency,
  makeEvent,
  makeTask,
  makeTasks,
} from "./factories.js";

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
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.decision.count()).toBe(0);
    expect(await prisma.taskDependency.count()).toBe(0);
    expect(await prisma.taskEvent.count()).toBe(0);
  });

  it("leaves rows behind in every table for the truncation above to clear", async () => {
    const task = await makeTask();
    const other = await makeTask();
    await makeComment({ taskId: task.id });
    await makeDecision({ taskId: task.id });
    await makeDependency(task.id, other.id);
    await makeEvent({ taskId: task.id });

    expect(await prisma.task.count()).toBe(2);
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.decision.count()).toBe(1);
    expect(await prisma.taskDependency.count()).toBe(1);
    expect(await prisma.taskEvent.count()).toBe(1);
  });

  it("restarts autoincrement ids from 1 in every test", async () => {
    // Runs after the test above, so this is also the proof that the feed —
    // which nothing cascades into — was cleared rather than carried over.
    expect(await prisma.taskEvent.count()).toBe(0);

    const task = await makeTask();
    const event = await makeEvent({ taskId: task.id });
    expect(task.id).toBe(1);
    expect(event.id).toBe(1);
  });
});

describe("factories", () => {
  it("defaults a task to backlog/medium, created by a human, with matching rank columns", async () => {
    const task = await makeTask();

    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("medium");
    expect(task.createdBy).toBe("human:tester");
    expect(task.version).toBe(1);
    expect(task.startedAt).toBeNull();
    expect(task.claimedBy).toBeNull();
  });

  it("sorts by lifecycle and severity rather than alphabetically, because the ranks are derived", async () => {
    await makeTask({ status: "done", priority: "high" });
    await makeTask({ status: "backlog", priority: "urgent" });
    await makeTask({ status: "in_progress", priority: "low" });

    const byStatus = await prisma.task.findMany({ orderBy: { statusRank: "asc" } });
    const byPriority = await prisma.task.findMany({ orderBy: { priorityRank: "desc" } });

    expect(byStatus.map((t) => t.status)).toEqual(["backlog", "in_progress", "done"]);
    expect(byPriority.map((t) => t.priority)).toEqual(["urgent", "high", "low"]);
  });

  it("gives an in_progress fixture a startedAt, and a done one a completedAt too", async () => {
    const started = await makeTask({ status: "in_progress" });
    const done = await makeTask({ status: "done" });

    expect(started.startedAt).not.toBeNull();
    expect(started.completedAt).toBeNull();
    expect(done.completedAt).not.toBeNull();
  });

  it("builds live and expired claims relative to the clock", async () => {
    const live = await makeTask(claimedBy("agent:a"));
    const expired = await makeTask(expiredClaimBy("agent:b"));

    expect(live.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(expired.claimExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(expired.claimedBy).toBe("agent:b");
  });

  it("creates tasks in id order, with per-index overrides", async () => {
    const tasks = await makeTasks(3, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));

    expect(tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(tasks.map((t) => t.createdAt.toISOString())).toEqual([
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
  it("writes a task with comments and cascades the delete", async () => {
    const task = await makeTask({ status: "in_progress", assignee: "Dana Ruiz" });
    await makeComment({ taskId: task.id, body: "first" });
    await makeComment({ taskId: task.id, body: "second" });

    const loaded = await prisma.task.findUnique({
      where: { id: task.id },
      include: { comments: { orderBy: { id: "asc" } } },
    });

    expect(loaded?.assignee).toBe("Dana Ruiz");
    expect(loaded?.comments.map((c) => c.body)).toEqual(["first", "second"]);

    await prisma.task.delete({ where: { id: task.id } });

    expect(await prisma.comment.count()).toBe(0);
  });
});
