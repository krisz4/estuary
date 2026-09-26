import { floorSnapshotSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { makeTask } from "../test/factories.js";

/**
 * `GET /api/v1/floor` — the HTTP layer. Service behaviour (scope vs filters,
 * the shipped window, the cap, the dependency graph, replay) is asserted in
 * `services/floor.service.test.ts`; this file covers the query surface and the
 * response shape end to end.
 */

const app = createApp();
const FLOOR = "/api/v1/floor";

describe("GET /api/v1/floor", () => {
  it("returns an empty, well-formed snapshot with nothing in the database", async () => {
    const res = await request(app).get(FLOOR);

    expect(res.status).toBe(200);
    expect(floorSnapshotSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ tasks: [], edges: [], refs: [] });
    expect(res.body.meta.total).toBe(0);
  });

  it("scopes by project and marks other filters as matches", async () => {
    await makeTask({ project: "helpdesk", status: "todo", priority: "urgent" });
    await makeTask({ project: "billing", status: "todo" });

    const res = await request(app).get(FLOOR).query({ project: "helpdesk", priority: "high" });

    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].project).toBe("helpdesk");
    expect(res.body.tasks[0].matches).toBe(false);
  });

  it("422s on an unknown parameter", async () => {
    const res = await request(app).get(FLOOR).query({ belts: "chain" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("422s on a malformed at", async () => {
    const res = await request(app).get(FLOOR).query({ at: "not-a-date" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("422s on an invalid shipped window", async () => {
    const res = await request(app).get(FLOOR).query({ shipped: "1y" });

    expect(res.status).toBe(422);
  });

  it("is read-only — a POST falls through to NOT_FOUND", async () => {
    const res = await request(app).post(FLOOR).send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
