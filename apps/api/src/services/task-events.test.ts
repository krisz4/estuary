import { eventsQuerySchema, taskEventSchema } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeEvent } from "../test/factories.js";
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
    expect(page.meta).toEqual({ nextAfter: 2, hasMore: false });
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
    expect(first.meta).toEqual({ nextAfter: 2, hasMore: true });
    expect(second.data.map((e) => e.id)).toEqual([3, 4]);
    expect(third.data.map((e) => e.id)).toEqual([5]);
    expect(third.meta).toEqual({ nextAfter: 5, hasMore: false });
  });

  it("reports hasMore: false when exactly limit events remain", async () => {
    for (let i = 0; i < 2; i += 1) await makeEvent({ taskId: 1 });

    expect((await feed({ limit: "2" })).meta).toEqual({ nextAfter: 2, hasMore: false });
  });

  it("echoes the incoming cursor as nextAfter when nothing new happened", async () => {
    await makeEvent({ taskId: 1 });

    expect(await feed({ after: "7" })).toEqual({
      data: [],
      meta: { nextAfter: 7, hasMore: false },
    });
    expect(await feed()).toMatchObject({ meta: { nextAfter: 1 } });
    await prisma.taskEvent.deleteMany();
    expect((await feed()).meta).toEqual({ nextAfter: 0, hasMore: false });
  });

  it("defaults the limit to 50", async () => {
    for (let i = 0; i < 51; i += 1) await makeEvent({ taskId: 1 });

    const page = await feed();
    expect(page.data).toHaveLength(50);
    expect(page.meta.hasMore).toBe(true);
  });
});

describe("recordEvent", () => {
  it("stores the payload as JSON and an empty object when none is given", async () => {
    await recordEvent(prisma, { taskId: 9, type: "task.updated", actor: "human:a" });

    const [event] = (await feed()).data;
    expect(event).toMatchObject({ taskId: 9, type: "task.updated", actor: "human:a", payload: {} });
  });
});
