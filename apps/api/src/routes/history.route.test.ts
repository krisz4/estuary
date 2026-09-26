import { historyResponseSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { makeEvent } from "../test/factories.js";

/**
 * `GET /api/v1/stats/history` — the HTTP layer. Bucket/metric behaviour is
 * asserted in `services/history.service.test.ts`; this covers the query
 * surface and the response shape end to end.
 */

const app = createApp();
const HISTORY = "/api/v1/stats/history";

describe("GET /api/v1/stats/history", () => {
  it("returns a well-formed, empty-range response with nothing in the database", async () => {
    const res = await request(app).get(HISTORY);

    expect(res.status).toBe(200);
    expect(historyResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.totals.created).toBe(0);
  });

  it("defaults to a 7-day range ending now, bucketed by day", async () => {
    const res = await request(app).get(HISTORY);

    expect(res.body.bucket).toBe("day");
    expect(res.body.buckets.length).toBeGreaterThanOrEqual(7);
  });

  it("counts real writes within an explicit range", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      payload: { status: "backlog", title: "x" },
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
    });

    const res = await request(app).get(HISTORY).query({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      bucket: "day",
    });

    expect(res.body.totals.created).toBe(1);
  });

  it("422s when to is not after from", async () => {
    const res = await request(app)
      .get(HISTORY)
      .query({ from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("422s a range producing too many buckets", async () => {
    const res = await request(app)
      .get(HISTORY)
      .query({ from: "2000-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z", bucket: "hour" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("422s on an unknown bucket", async () => {
    const res = await request(app).get(HISTORY).query({ bucket: "month" });

    expect(res.status).toBe(422);
  });

  it("is read-only — a POST falls through to NOT_FOUND", async () => {
    const res = await request(app).post(HISTORY).send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
