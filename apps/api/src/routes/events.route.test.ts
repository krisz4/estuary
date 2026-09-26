import { eventsResponseSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { makeEvent } from "../test/factories.js";

/**
 * `GET /api/v1/events` — the change feed, through HTTP
 * (`docs/features/Task_Workflow_API.md` § Events). The paging arithmetic is in
 * `services/task-events.test.ts`; this file covers the query surface and the
 * end-to-end promise that real writes land in the feed and outlive their task.
 */

const app = createApp();

const FEED = "/api/v1/events";
const TASKS = "/api/v1/tasks";

const types = (body: { data: { type: string }[] }) => body.data.map((event) => event.type);

describe("GET /api/v1/events", () => {
  it("returns an empty feed with nextAfter 0 before anything happened", async () => {
    const res = await request(app).get(FEED);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: { nextAfter: 0, nextBefore: null, hasMore: false } });
  });

  it("records real writes, oldest first, attributed to their X-Actor", async () => {
    const created = await request(app).post(TASKS).set("X-Actor", "agent:claude-code").send({
      title: "Add retries to the sender",
      description: "Deliveries fail on the first 502.",
    });
    const id = created.body.id as number;
    await request(app)
      .patch(`${TASKS}/${id}`)
      .set("X-Actor", "human:krisz")
      .send({ priority: "high" });
    await request(app).post(`${TASKS}/${id}/comments`).send({ body: "Looks right." });

    const res = await request(app).get(FEED);

    expect(eventsResponseSchema.safeParse(res.body).success).toBe(true);
    expect(types(res.body)).toEqual(["task.created", "task.updated", "comment.created"]);
    expect(res.body.data.map((event: { actor: string }) => event.actor)).toEqual([
      "agent:claude-code",
      "human:krisz",
      "human:anonymous",
    ]);
    expect(res.body.data[1].payload).toEqual({ fields: ["priority"] });
    expect(res.body.data.map((event: { taskTitle: string | null }) => event.taskTitle)).toEqual([
      "Add retries to the sender",
      "Add retries to the sender",
      "Add retries to the sender",
    ]);
  });

  it("still describes a task after it is deleted, with taskTitle null", async () => {
    const created = await request(app)
      .post(TASKS)
      .send({ title: "Short-lived task", description: "Created only to be deleted." });
    const id = created.body.id as number;
    await request(app).delete(`${TASKS}/${id}`);

    const res = await request(app)
      .get(FEED)
      .query({ taskId: String(id) });

    expect(types(res.body)).toEqual(["task.created", "task.deleted"]);
    expect(res.body.data[1].payload).toEqual({ title: "Short-lived task" });
    expect(res.body.data.map((event: { taskTitle: string | null }) => event.taskTitle)).toEqual([
      null,
      null,
    ]);
    expect((await request(app).get(`${TASKS}/${id}`)).status).toBe(404);
  });

  it("returns only events after the cursor, filtered to one task", async () => {
    await makeEvent({ taskId: 1 });
    await makeEvent({ taskId: 2 });
    await makeEvent({ taskId: 1 });
    await makeEvent({ taskId: 1 });

    const res = await request(app).get(FEED).query({ after: "1", taskId: "1" });

    expect(res.body.data.map((event: { id: number }) => event.id)).toEqual([3, 4]);
    expect(res.body.meta).toEqual({ nextAfter: 4, nextBefore: null, hasMore: false });
  });

  it("pages with limit and reports hasMore", async () => {
    for (let i = 0; i < 3; i += 1) await makeEvent({ taskId: 1 });

    const first = await request(app).get(FEED).query({ limit: "2" });
    const second = await request(app)
      .get(FEED)
      .query({ limit: "2", after: String(first.body.meta.nextAfter) });

    expect(first.body.meta).toEqual({ nextAfter: 2, nextBefore: null, hasMore: true });
    expect(second.body.data.map((event: { id: number }) => event.id)).toEqual([3]);
    expect(second.body.meta).toEqual({ nextAfter: 3, nextBefore: null, hasMore: false });
  });

  it("echoes the cursor back as nextAfter when a poll finds nothing new", async () => {
    await makeEvent({ taskId: 1 });

    const res = await request(app).get(FEED).query({ after: "1" });

    expect(res.body).toEqual({ data: [], meta: { nextAfter: 1, nextBefore: null, hasMore: false } });
  });

  it("treats empty values as absent", async () => {
    await makeEvent({ taskId: 1 });

    const res = await request(app).get(`${FEED}?after=&limit=&taskId=`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it.each([
    ["a non-numeric cursor", { after: "abc" }, "after"],
    ["a negative cursor", { after: "-1" }, "after"],
    ["a hex taskId", { taskId: "0x2a" }, "taskId"],
    ["taskId 0", { taskId: "0" }, "taskId"],
    ["limit 0", { limit: "0" }, "limit"],
    ["limit above the maximum", { limit: "201" }, "limit"],
    ["a fractional limit", { limit: "2.5" }, "limit"],
  ])("returns 422 VALIDATION_ERROR for %s", async (_label, query, field) => {
    const res = await request(app).get(FEED).query(query);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  it("returns 422 for an unknown parameter", async () => {
    const res = await request(app).get(FEED).query({ since: "yesterday" });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain("since");
  });

  it("is read-only — a POST falls through to NOT_FOUND", async () => {
    const res = await request(app).post(FEED).send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("pages newest-first with order=desc and before, over real writes", async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post(TASKS)
        .send({ title: `Task number ${i}`, description: "Long enough description for the schema." });
    }

    const first = await request(app).get(FEED).query({ order: "desc", limit: "2" });
    expect(eventsResponseSchema.safeParse(first.body).success).toBe(true);
    expect(first.body.data.map((e: { id: number }) => e.id)).toEqual([3, 2]);

    const second = await request(app)
      .get(FEED)
      .query({ order: "desc", limit: "2", before: String(first.body.meta.nextBefore) });
    expect(second.body.data.map((e: { id: number }) => e.id)).toEqual([1]);
    expect(second.body.meta.nextBefore).toBe(1);
  });

  it("rejects order values other than asc/desc", async () => {
    const res = await request(app).get(FEED).query({ order: "sideways" });

    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details)).toContain("order");
  });
});
