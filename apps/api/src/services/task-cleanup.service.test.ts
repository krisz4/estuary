import { SYSTEM_ACTOR, TASK_STATUSES } from "@estuary/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  eventsFor,
  makeComment,
  makeDecision,
  makeDependency,
  makeTask,
} from "../test/factories.js";
import { cleanupDoneTasks, startRetentionSweep, sweepDoneTasks } from "./task-cleanup.service.js";

/**
 * Bulk delete of done tasks — `docs/features/Task_Cleanup.md`. Against the
 * worker's temp SQLite file, like every other service test.
 */

const HUMAN = "human:krisz";
const AGENT = "agent:claude-code";
const NOW = new Date("2026-09-27T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const remainingIds = async () =>
  (await prisma.task.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((t) => t.id);

describe("cleanupDoneTasks", () => {
  it("deletes every done task and nothing in any other status", async () => {
    const others = [];
    for (const status of TASK_STATUSES.filter((s) => s !== "done")) {
      others.push(await makeTask({ status }));
    }
    const done1 = await makeTask({ status: "done" });
    const done2 = await makeTask({ status: "done" });

    const result = await cleanupDoneTasks({}, HUMAN, NOW);

    expect(result).toEqual({ deleted: 2, taskIds: [done1.id, done2.id], dryRun: false });
    expect(await remainingIds()).toEqual(others.map((t) => t.id));
  });

  it("records task.deleted with reason cleanup, keeping earlier events", async () => {
    const task = await makeTask({ status: "done", title: "Ship it", project: "estuary" });

    await cleanupDoneTasks({}, HUMAN, NOW);

    expect(await eventsFor(task.id)).toEqual([
      { type: "task.deleted", actor: HUMAN, payload: { title: "Ship it", reason: "cleanup" } },
    ]);
    const event = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id } });
    expect(event.project).toBe("estuary");
  });

  it("cascades comments, decisions, and dependency rows; subtasks survive unparented", async () => {
    const parent = await makeTask({ status: "done" });
    const child = await makeTask({ status: "todo", parentId: parent.id });
    await makeComment({ taskId: parent.id });
    await makeDecision({ taskId: parent.id, status: "answered" });
    await makeDependency(child.id, parent.id);

    await cleanupDoneTasks({}, HUMAN, NOW);

    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.decision.count()).toBe(0);
    expect(await prisma.taskDependency.count()).toBe(0);
    const survivor = await prisma.task.findUniqueOrThrow({ where: { id: child.id } });
    expect(survivor.parentId).toBeNull();
  });

  it("scopes to the given projects", async () => {
    await makeTask({ status: "done", project: "estuary" });
    const kept = await makeTask({ status: "done", project: "other" });
    const unscoped = await makeTask({ status: "done" });

    const result = await cleanupDoneTasks({ project: ["estuary"] }, HUMAN, NOW);

    expect(result.deleted).toBe(1);
    expect(await remainingIds()).toEqual([kept.id, unscoped.id]);
  });

  it("with olderThanDays, keeps tasks completed more recently", async () => {
    const old = await makeTask({ status: "done", completedAt: daysAgo(91) });
    const recent = await makeTask({ status: "done", completedAt: daysAgo(89) });

    const result = await cleanupDoneTasks({ olderThanDays: 90 }, HUMAN, NOW);

    expect(result.taskIds).toEqual([old.id]);
    expect(await remainingIds()).toEqual([recent.id]);
  });

  it("falls back to updatedAt when completedAt is missing", async () => {
    const stale = await makeTask({ status: "done", completedAt: null });
    await prisma.$executeRaw`UPDATE "Task" SET "updatedAt" = ${daysAgo(120)} WHERE "id" = ${stale.id}`;
    const fresh = await makeTask({ status: "done", completedAt: null });

    const result = await cleanupDoneTasks({ olderThanDays: 90 }, HUMAN, NOW);

    expect(result.taskIds).toEqual([stale.id]);
    expect(await remainingIds()).toEqual([fresh.id]);
  });

  it("olderThanDays 0 means every done task", async () => {
    await makeTask({ status: "done", completedAt: NOW });

    expect((await cleanupDoneTasks({ olderThanDays: 0 }, HUMAN, NOW)).deleted).toBe(1);
  });

  it("dry run reports without deleting or recording events", async () => {
    const task = await makeTask({ status: "done" });

    const result = await cleanupDoneTasks({ dryRun: true }, HUMAN, NOW);

    expect(result).toEqual({ deleted: 1, taskIds: [task.id], dryRun: true });
    expect(await remainingIds()).toEqual([task.id]);
    expect(await prisma.taskEvent.count()).toBe(0);
  });

  it("refuses agents, dry run included", async () => {
    await makeTask({ status: "done" });

    for (const dryRun of [false, true]) {
      const error = await cleanupDoneTasks({ dryRun }, AGENT, NOW).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("ACTOR_NOT_PERMITTED");
    }
    expect(await prisma.task.count()).toBe(1);
  });

  it("returns zero when there is nothing to delete", async () => {
    await makeTask({ status: "todo" });

    expect(await cleanupDoneTasks({}, HUMAN, NOW)).toEqual({
      deleted: 0,
      taskIds: [],
      dryRun: false,
    });
  });
});

describe("retention sweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweepDoneTasks deletes as system:taskmanager, only past the window", async () => {
    const old = await makeTask({ status: "done", completedAt: daysAgo(100) });
    const recent = await makeTask({ status: "done", completedAt: daysAgo(10) });

    const result = await sweepDoneTasks(90, NOW);

    expect(result.taskIds).toEqual([old.id]);
    expect(await remainingIds()).toEqual([recent.id]);
    expect((await eventsFor(old.id))[0]?.actor).toBe(SYSTEM_ACTOR);
  });

  it("startRetentionSweep with 0 days starts nothing", async () => {
    await makeTask({ status: "done", completedAt: new Date(0) });

    const stop = startRetentionSweep(0);
    stop();

    expect(await prisma.task.count()).toBe(1);
  });

  it("startRetentionSweep runs once immediately", async () => {
    await makeTask({ status: "done", completedAt: new Date(Date.now() - 200 * 86_400_000) });

    const stop = startRetentionSweep(90);
    await vi.waitFor(async () => expect(await prisma.task.count()).toBe(0));
    stop();
  });
});
