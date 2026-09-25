import { ANONYMOUS_ACTOR, apiErrorResponseSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { makeTask } from "../test/factories.js";

/**
 * `X-Actor` → `req.actor` (`middleware/actor.ts`, `docs/features/Actors.md`).
 * Asserted through real requests, because what matters is what gets
 * *recorded* — `createdBy`, comment authors, event actors — not what the
 * middleware assigns to a property.
 */

const app = createApp();

const TASK = {
  title: "Add retries to the webhook sender",
  description: "Deliveries fail permanently on the first 502 from the receiver.",
};

const create = (actor?: string) => {
  const req = request(app).post("/api/v1/tasks");
  if (actor !== undefined) req.set("X-Actor", actor);
  return req.send(TASK);
};

describe("X-Actor", () => {
  it("records a request without the header as human:anonymous", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe(ANONYMOUS_ACTOR);
    expect(ANONYMOUS_ACTOR).toBe("human:anonymous");
  });

  it("treats a blank header as absent", async () => {
    expect((await create("   ")).body.createdBy).toBe(ANONYMOUS_ACTOR);
  });

  it.each([
    ["agent:claude-code", "agent:claude-code"],
    ["human:krisz", "human:krisz"],
    ["Agent:Claude-Code", "agent:claude-code"],
    ["  human:Dana.W@example.com  ", "human:dana.w@example.com"],
  ])(
    "records %j as %j — lowercased, like every exact-match actor filter expects",
    async (sent, stored) => {
      const res = await create(sent);

      expect(res.status).toBe(201);
      expect(res.body.createdBy).toBe(stored);
      const events = await prisma.taskEvent.findMany();
      expect(events.map((event) => event.actor)).toEqual([stored]);
    },
  );

  it.each([
    ["no kind", "claude-code"],
    ["an unknown kind", "robot:claude"],
    ["an empty name", "agent:"],
    ["a space in the name", "agent:claude code"],
    ["the reserved system kind", "system:taskmanager"],
    ["an over-long name", `agent:${"a".repeat(65)}`],
  ])(
    "rejects %s with 422 VALIDATION_ERROR on details['X-Actor'], writing nothing",
    async (_label, sent) => {
      const res = await create(sent);

      expect(res.status).toBe(422);
      const parsed = apiErrorResponseSchema.parse(res.body);
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(parsed.error.details as object)).toEqual(["X-Actor"]);
      expect(await prisma.task.count()).toBe(0);
    },
  );

  it("is checked on reads too, so a misconfigured agent fails on its first GET", async () => {
    const res = await request(app).get("/api/v1/tasks").set("X-Actor", "claude");

    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty("X-Actor");
  });

  it("attributes comments and workflow writes to the header's actor", async () => {
    const task = await makeTask({ status: "todo" });

    await request(app)
      .post(`/api/v1/tasks/${task.id}/comments`)
      .set("X-Actor", "agent:worker")
      .send({ body: "Starting on this." });
    const claimed = await request(app)
      .post(`/api/v1/tasks/${task.id}/claim`)
      .set("X-Actor", "agent:worker");

    expect(claimed.body.claim.actor).toBe("agent:worker");
    expect(claimed.body.comments[0].author).toBe("agent:worker");
  });

  it("is not consulted outside /api/v1", async () => {
    const res = await request(app).get("/health").set("X-Actor", "not an actor");

    expect(res.status).toBe(200);
  });
});
