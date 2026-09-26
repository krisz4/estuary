import { eventsQuerySchema, taskEventSchema } from "@helpdesk/contracts";
import { describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeEvent, makeTask } from "../test/factories.js";
import { listEvents, recordEvent } from "./task-events.js";

/**
 * The events feed — `docs/features/Task_Workflow_API.md` § Events. Rows are
 * arranged directly with `makeEvent`, so ids are exact (truncation resets the
 * sequence) and no task needs to exist: the feed must describe tasks that are
 * gone.
 */

const feed = (raw: Record<string, unknown> = {}) => listEvents(eventsQuerySchema.parse(raw));

const ids = async (raw: Record<string, unknown> = {}) => (await feed(raw)).data.map((e) => e.id);

describe("listEvents", () => {
  it("returns events oldest first, serialized through the contract", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      payload: { status: "backlog", title: "x" },
    });
    await makeEvent({ taskId: 2, type: "task.deleted", payload: { title: "y" } });

    const page = await feed();

    expect(page.data.map((event) => event.id)).toEqual([1, 2]);
    expect(page.data[0]?.payload).toEqual({ status: "backlog", title: "x" });
    for (const event of page.data) expect(taskEventSchema.safeParse(event).success).toBe(true);
    expect(page.meta).toEqual({ nextAfter: 2, nextBefore: null, hasMore: false });
  });

  it("returns only events strictly after the cursor", async () => {
    for (let i = 0; i < 4; i += 1) await makeEvent({ taskId: 1 });

    expect(await ids({ after: "2" })).toEqual([3, 4]);
  });

  it("filters by taskId", async () => {
    await makeEvent({ taskId: 1 });
    await makeEvent({ taskId: 2 });
    await makeEvent({ taskId: 1 });

    expect(await ids({ taskId: "1" })).toEqual([1, 3]);
  });

  it("pages by limit, reports hasMore, and hands back the last id as nextAfter", async () => {
    for (let i = 0; i < 5; i += 1) await makeEvent({ taskId: 1 });

    const first = await feed({ limit: "2" });
    const second = await feed({ limit: "2", after: String(first.meta.nextAfter) });
    const third = await feed({ limit: "2", after: String(second.meta.nextAfter) });

    expect(first.data.map((e) => e.id)).toEqual([1, 2]);
    expect(first.meta).toEqual({ nextAfter: 2, nextBefore: null, hasMore: true });
    expect(second.data.map((e) => e.id)).toEqual([3, 4]);
    expect(third.data.map((e) => e.id)).toEqual([5]);
    expect(third.meta).toEqual({ nextAfter: 5, nextBefore: null, hasMore: false });
  });

  it("reports hasMore: false when exactly limit events remain", async () => {
    for (let i = 0; i < 2; i += 1) await makeEvent({ taskId: 1 });

    expect((await feed({ limit: "2" })).meta).toEqual({ nextAfter: 2, nextBefore: null, hasMore: false });
  });

  it("echoes the incoming cursor as nextAfter when nothing new happened", async () => {
    await makeEvent({ taskId: 1 });

    expect(await feed({ after: "7" })).toEqual({
      data: [],
      meta: { nextAfter: 7, nextBefore: null, hasMore: false },
    });
    expect(await feed()).toMatchObject({ meta: { nextAfter: 1 } });
    await prisma.taskEvent.deleteMany();
    expect((await feed()).meta).toEqual({ nextAfter: 0, nextBefore: null, hasMore: false });
  });

  it("defaults the limit to 50", async () => {
    for (let i = 0; i < 51; i += 1) await makeEvent({ taskId: 1 });

    const page = await feed();
    expect(page.data).toHaveLength(50);
    expect(page.meta.hasMore).toBe(true);
  });

  describe("order=desc paging", () => {
    it("returns newest first and sets nextBefore to the smallest id on the page", async () => {
      for (let i = 0; i < 4; i += 1) await makeEvent({ taskId: 1 });

      const page = await feed({ order: "desc" });

      expect(page.data.map((e) => e.id)).toEqual([4, 3, 2, 1]);
      expect(page.meta).toEqual({ nextAfter: 4, nextBefore: 1, hasMore: false });
    });

    it("pages backwards with before, oldest page nextBefore null", async () => {
      for (let i = 0; i < 5; i += 1) await makeEvent({ taskId: 1 });

      const first = await feed({ order: "desc", limit: "2" });
      expect(first.data.map((e) => e.id)).toEqual([5, 4]);
      expect(first.meta).toEqual({ nextAfter: 5, nextBefore: 4, hasMore: true });

      const second = await feed({ order: "desc", limit: "2", before: String(first.meta.nextBefore) });
      expect(second.data.map((e) => e.id)).toEqual([3, 2]);
      expect(second.meta).toEqual({ nextAfter: 3, nextBefore: 2, hasMore: true });

      const third = await feed({ order: "desc", limit: "2", before: String(second.meta.nextBefore) });
      expect(third.data.map((e) => e.id)).toEqual([1]);
      expect(third.meta).toEqual({ nextAfter: 1, nextBefore: 1, hasMore: false });
    });

    it("echoes 0 as nextAfter and null as nextBefore for an empty desc page", async () => {
      const page = await feed({ order: "desc" });
      expect(page).toEqual({ data: [], meta: { nextAfter: 0, nextBefore: null, hasMore: false } });
    });

    it("combines before with taskId and project the same way after does", async () => {
      await makeEvent({ taskId: 1, project: "helpdesk" });
      await makeEvent({ taskId: 2, project: "billing" });
      await makeEvent({ taskId: 1, project: "helpdesk" });

      const page = await feed({ order: "desc", taskId: "1" });
      expect(page.data.map((e) => e.id)).toEqual([3, 1]);
    });
  });

  describe("from / to", () => {
    it("keeps events at or after from, and strictly before to", async () => {
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const t1 = new Date("2026-01-02T00:00:00.000Z");
      const t2 = new Date("2026-01-03T00:00:00.000Z");
      await makeEvent({ taskId: 1, createdAt: t0 });
      await makeEvent({ taskId: 1, createdAt: t1 });
      await makeEvent({ taskId: 1, createdAt: t2 });

      expect(await ids({ from: t1.toISOString() })).toEqual([2, 3]);
      expect(await ids({ to: t1.toISOString() })).toEqual([1]);
      expect(await ids({ from: t1.toISOString(), to: t2.toISOString() })).toEqual([2]);
    });
  });

  it("order=asc with no before/from/to is unaffected by their existence — the original poller shape", async () => {
    for (let i = 0; i < 3; i += 1) await makeEvent({ taskId: 1 });

    expect(await feed()).toEqual(await feed({ order: "asc" }));
  });
});

describe("taskTitle", () => {
  it("attaches the task's current title", async () => {
    const task = await makeTask({ title: "Accept a project filter" });
    await makeEvent({ taskId: task.id, type: "task.created" });

    const [event] = (await feed()).data;
    expect(event?.taskTitle).toBe("Accept a project filter");
  });

  it("is null for a task that no longer exists", async () => {
    await makeEvent({ taskId: 999_999, type: "task.deleted" });

    const [event] = (await feed()).data;
    expect(event?.taskTitle).toBeNull();
  });

  it("reflects the task's latest title, not the title at event time", async () => {
    const task = await makeTask({ title: "Original title" });
    await makeEvent({ taskId: task.id, type: "task.created" });
    await prisma.task.update({ where: { id: task.id }, data: { title: "Renamed title" } });

    const [event] = (await feed()).data;
    expect(event?.taskTitle).toBe("Renamed title");
  });

  it("fetches titles for many events' distinct taskIds in a single query", async () => {
    const taskA = await makeTask({ title: "Task A" });
    const taskB = await makeTask({ title: "Task B" });
    await makeEvent({ taskId: taskA.id });
    await makeEvent({ taskId: taskB.id });
    await makeEvent({ taskId: taskA.id });
    await makeEvent({ taskId: taskB.id });

    const spy = vi.spyOn(prisma.task, "findMany");
    const page = await feed();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(page.data.map((e) => e.taskTitle)).toEqual(["Task A", "Task B", "Task A", "Task B"]);
    spy.mockRestore();
  });
});

describe("recordEvent", () => {
  it("stores the payload as JSON and an empty object when none is given", async () => {
    await recordEvent(prisma, { taskId: 9, type: "task.updated", actor: "human:a" });

    const [event] = (await feed()).data;
    expect(event).toMatchObject({ taskId: 9, type: "task.updated", actor: "human:a", payload: {} });
  });
});
