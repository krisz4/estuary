import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { makeTasks } from "../test/factories.js";

/**
 * Concurrent requests against one SQLite file (`docs/engineering/DATABASE.md`
 * § Concurrent writes).
 *
 * Before the in-process write queue, two interactive transactions that had
 * both read could not both upgrade to a write lock: SQLite refused one, the
 * other waited on it, and the pair ended as "Socket timeout" 500s — 9 of 15
 * concurrent `POST /tasks` failed that way. Every assertion here is "all of
 * them succeeded", because the failure mode was a fraction of them not doing so.
 */

const app = createApp();
const BASE = "/api/v1/tasks";

const statusesOf = (responses: request.Response[]) => responses.map((res) => res.status);

describe("concurrent requests", () => {
  it("creates 20 tasks fired at once without a single failure", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app)
          .post(BASE)
          .set("X-Actor", `agent:worker-${i % 4}`)
          .send({ title: `Concurrent task ${i}`, description: "Created in a burst of twenty." }),
      ),
    );

    expect(statusesOf(responses)).toEqual(Array(20).fill(201));
    expect(new Set(responses.map((res) => res.body.id)).size).toBe(20);
    expect(await prisma.task.count()).toBe(20);
    expect(await prisma.taskEvent.count({ where: { type: "task.created" } })).toBe(20);
  });

  it("serves 20 list reads at once, while writes are landing", async () => {
    await makeTasks(15);

    const [reads, writes] = await Promise.all([
      Promise.all(
        Array.from({ length: 20 }, () => request(app).get(BASE).query({ pageSize: "5" })),
      ),
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(app)
            .post(BASE)
            .send({
              title: `Written during reads ${i}`,
              description: "Lands while the list is read.",
            }),
        ),
      ),
    ]);

    expect(statusesOf(reads)).toEqual(Array(20).fill(200));
    expect(statusesOf(writes)).toEqual(Array(5).fill(201));
    for (const res of reads) {
      // Each page agrees with its own total: the page and the count come from
      // one snapshot.
      expect(res.body.data.length).toBe(Math.min(5, res.body.meta.total));
    }
  });

  it("handles comments, next, and patches interleaved on the same tasks", async () => {
    const tasks = await makeTasks(6, () => ({ status: "todo" }));

    const responses = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        request(app).post(`${BASE}/next`).set("X-Actor", `agent:worker-${i}`).send({}),
      ),
      ...tasks.map((task) =>
        request(app)
          .post(`${BASE}/${task.id}/comments`)
          .set("X-Actor", "human:krisz")
          .send({ body: "Any update on this?" }),
      ),
      ...tasks.map((task) =>
        request(app)
          .patch(`${BASE}/${task.id}`)
          .set("X-Actor", "human:krisz")
          .send({ priority: "high" }),
      ),
    ]);

    // No 500s anywhere. A PATCH may legitimately lose to an agent's claim only
    // if it is an agent — these are human, so every one of them succeeds.
    expect(responses.filter((res) => res.status >= 500)).toEqual([]);
    const next = responses.slice(0, 8);
    const comments = responses.slice(8, 14);
    const patches = responses.slice(14);
    expect(statusesOf(next)).toEqual(Array(8).fill(200));
    expect(statusesOf(comments)).toEqual(Array(6).fill(201));
    expect(statusesOf(patches)).toEqual(Array(6).fill(200));

    const handed = next.map((res) => res.body.task).filter((task) => task !== null);
    expect(handed).toHaveLength(6);
    expect(new Set(handed.map((task: { id: number }) => task.id)).size).toBe(6);
    expect(await prisma.comment.count()).toBe(6);
  });

  it("keeps serving writes after one of them fails", async () => {
    const responses = await Promise.all([
      request(app).patch(`${BASE}/999`).send({ priority: "high" }),
      request(app)
        .post(BASE)
        .send({ title: "After a failure", description: "Must still be created." }),
      request(app).post(`${BASE}/999/transition`).send({ to: "todo" }),
      request(app)
        .post(BASE)
        .send({ title: "After a second failure", description: "Also created." }),
    ]);

    expect(statusesOf(responses)).toEqual([404, 201, 404, 201]);
  });
});
