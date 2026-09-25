import {
  apiErrorResponseSchema,
  paginatedTasksSchema,
  TASK_STATUSES,
  taskSchema,
  taskStatsSchema,
} from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  eventsFor,
  expiredClaimBy,
  makeComment,
  makeDecision,
  makeDependency,
  makeTask,
  makeTaskAwaitingDecision,
  makeTasks,
} from "../test/factories.js";

/**
 * `/api/v1/tasks` route integration tests for the resource itself — create,
 * read, list, facets, stats, patch, delete. The workflow endpoints are in
 * `tasks.workflow.route.test.ts`.
 *
 * These run against the real Express app and the worker's temp SQLite file.
 * Service behaviour is asserted in `services/*.test.ts` and not re-asserted in
 * depth here — what is asserted is what only the HTTP layer can get wrong:
 * status codes, headers, route ordering, which parse failure becomes which
 * error code, and that `X-Actor` reaches the service.
 */

const app = createApp();

const BASE = "/api/v1/tasks";
const AGENT = "agent:claude-code";
const OTHER_AGENT = "agent:codex";
const HUMAN = "human:krisz";

const validTask = {
  title: "Add retries to the webhook sender",
  description: "Deliveries fail permanently on the first 502 from the receiver.",
};

/** Every failure must satisfy the envelope contract, not merely carry a code. */
const expectEnvelope = (body: unknown, code: string) => {
  const parsed = apiErrorResponseSchema.safeParse(body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  expect(parsed.data?.error.message.length).toBeGreaterThan(0);
  expect(parsed.data?.error.requestId.length).toBeGreaterThan(0);
};

const ids = (body: { data: { id: number }[] }) => body.data.map((task) => task.id);

/* ------------------------------------------------------------------ *
 * POST /tasks
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks", () => {
  it("returns 201 with a Location header pointing at the created task", async () => {
    const res = await request(app).post(BASE).send(validTask);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`${BASE}/${res.body.id}`);
  });

  it("returns a body satisfying taskSchema, with an integer id and its reference", async () => {
    const res = await request(app).post(BASE).send(validTask);

    const parsed = taskSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.body.reference).toBe(`TASK-${String(res.body.id).padStart(6, "0")}`);
    expect(res.body.comments).toEqual([]);
    expect(res.body.decisions).toEqual([]);
  });

  it("applies the documented defaults: backlog, medium, version 1", async () => {
    const res = await request(app).post(BASE).send(validTask);

    expect(res.body).toMatchObject({ status: "backlog", priority: "medium", version: 1 });
    expect(res.body.claim).toBeNull();
  });

  it("records the X-Actor as createdBy", async () => {
    const res = await request(app).post(BASE).set("X-Actor", AGENT).send(validTask);

    expect(res.body.createdBy).toBe(AGENT);
  });

  it.each(["backlog", "needs_refinement", "todo"])(
    "accepts %s as the initial status",
    async (status) => {
      const res = await request(app)
        .post(BASE)
        .send({ ...validTask, status, acceptanceCriteria: "Retries three times with backoff" });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(status);
    },
  );

  it.each(TASK_STATUSES.filter((s) => !["backlog", "needs_refinement", "todo"].includes(s)))(
    "rejects %s as the initial status on the status field",
    async (status) => {
      const res = await request(app)
        .post(BASE)
        .send({ ...validTask, status });

      expect(res.status).toBe(422);
      expect(Object.keys(res.body.error.details)).toEqual(["status"]);
    },
  );

  it("requires acceptanceCriteria to create straight into todo", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTask, status: "todo" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toEqual(["acceptanceCriteria"]);
  });

  it("lowercases the project", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTask, project: "HelpDesk" });

    expect(res.body.project).toBe("helpdesk");
  });

  it("stores empty assignee, project, and acceptanceCriteria as null", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTask, assignee: "", project: "", acceptanceCriteria: "" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ assignee: null, project: null, acceptanceCriteria: null });
  });

  it("returns 422 VALIDATION_ERROR naming each offending field in details", async () => {
    const res = await request(app)
      .post(BASE)
      .send({
        title: "hi",
        description: "short",
        project: "two words",
        links: [{ label: "x", url: "nope" }],
      });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      "description",
      "links.0.url",
      "project",
      "title",
    ]);
  });

  it.each([
    ["id", 99],
    ["createdAt", "2020-01-01T00:00:00.000Z"],
    ["createdBy", "agent:impostor"],
    ["version", 7],
    ["claim", null],
  ])("rejects a client-supplied %s instead of silently stripping it", async (key, value) => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTask, [key]: value });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(await prisma.task.count()).toBe(0);
  });

  describe("idempotencyKey", () => {
    it("replays with 200, the same task, and a Location — even when the body differs", async () => {
      const first = await request(app)
        .post(BASE)
        .set("X-Actor", AGENT)
        .send({ ...validTask, idempotencyKey: "cc:helpdesk:webhook-retries" });

      const replay = await request(app).post(BASE).set("X-Actor", AGENT).send({
        title: "Something else entirely",
        description: "A different body under the same key.",
        priority: "urgent",
        idempotencyKey: "cc:helpdesk:webhook-retries",
      });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.title).toBe(validTask.title);
      expect(replay.body.priority).toBe("medium");
      expect(replay.headers.location).toBe(`${BASE}/${first.body.id}`);
      expect(await prisma.task.count()).toBe(1);
    });
  });

  describe("parentId", () => {
    it("creates a subtask of an existing task", async () => {
      const parent = await makeTask();

      const res = await request(app)
        .post(BASE)
        .send({ ...validTask, parentId: parent.id });

      expect(res.status).toBe(201);
      expect(res.body.parent.id).toBe(parent.id);
    });

    it("returns 422 on parentId for a parent that does not exist", async () => {
      const res = await request(app)
        .post(BASE)
        .send({ ...validTask, parentId: 4242 });

      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual({ parentId: ["Task 4242 does not exist"] });
    });
  });
});

/* ------------------------------------------------------------------ *
 * GET /tasks/:taskId
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tasks/:taskId", () => {
  it("returns 200 with the comment thread oldest-first and the decision history newest-first", async () => {
    const task = await makeTask({ status: "needs_user_decision" });
    const sameMs = new Date("2026-08-11T09:00:00.000Z");
    await makeComment({ taskId: task.id, body: "first", createdAt: sameMs });
    await makeComment({ taskId: task.id, body: "second", createdAt: sameMs });
    const older = await makeDecision({ taskId: task.id, status: "withdrawn" });
    const open = await makeDecision({ taskId: task.id });

    const res = await request(app).get(`${BASE}/${task.id}`);

    expect(res.status).toBe(200);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual(["first", "second"]);
    expect(res.body.commentCount).toBe(2);
    expect(res.body.decisions.map((d: { id: number }) => d.id)).toEqual([open.id, older.id]);
    expect(res.body.openDecision.id).toBe(open.id);
    expect(taskSchema.safeParse(res.body).success).toBe(true);
  });

  it("returns 404 TASK_NOT_FOUND for an id that does not exist", async () => {
    const res = await request(app).get(`${BASE}/999999`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
  });

  /**
   * A malformed id and a missing task are indistinguishable to a caller. A 422
   * here would tell a prober which ids are well-formed.
   */
  it.each(["abc", "1.5", "0x2a", "1e3", "-1", "0", "%20"])(
    "returns 404, not 422 and not 500, for the non-numeric id %j",
    async (segment) => {
      const res = await request(app).get(`${BASE}/${segment}`);

      expect(res.status).toBe(404);
      expectEnvelope(res.body, "TASK_NOT_FOUND");
      expect(res.body.error.details).toBeUndefined();
    },
  );

  it("does not resolve task 42 under an alias spelling of its id", async () => {
    await makeTasks(42);

    expect((await request(app).get(`${BASE}/42`)).status).toBe(200);
    expect((await request(app).get(`${BASE}/0x2a`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/1e3`)).status).toBe(404);
    // Over `TASK_ID_MAX_DIGITS` — see `docs/features/Task_Numbering.md`.
    expect((await request(app).get(`${BASE}/0000000000000000042`)).status).toBe(404);
  });

  it("resolves a padded id identically through the path and through search", async () => {
    await makeTasks(42);

    expect((await request(app).get(`${BASE}/042`)).body.id).toBe(42);
    expect((await request(app).get(BASE).query({ q: "042" })).body.data[0].id).toBe(42);
    expect((await request(app).get(BASE).query({ q: "0000000000000000042" })).body.meta.total).toBe(
      0,
    );
  });
});

/* ------------------------------------------------------------------ *
 * GET /tasks/facets and /tasks/stats — the route-ordering trap
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tasks/facets", () => {
  /**
   * With `/:taskId` declared first, `facets` is captured as an id, fails the
   * digits-only parse, and comes back 404 `TASK_NOT_FOUND`.
   */
  it("is matched as its own route, not captured as :taskId", async () => {
    const res = await request(app).get(`${BASE}/facets`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignees: [], projects: [], creators: [] });
  });

  it("returns the distinct non-null values actually present, sorted", async () => {
    await makeTask({ assignee: "Priya Raman", project: "web", createdBy: AGENT });
    await makeTask({ assignee: "Marcus Feld", project: "web", createdBy: HUMAN });
    await makeTask({ assignee: null, project: null, createdBy: AGENT });

    const res = await request(app).get(`${BASE}/facets`);

    expect(res.body).toEqual({
      assignees: ["Marcus Feld", "Priya Raman"],
      projects: ["web"],
      creators: [AGENT, HUMAN],
    });
  });
});

describe("GET /api/v1/tasks/stats", () => {
  it("is matched as its own route and reports all ten statuses", async () => {
    const res = await request(app).get(`${BASE}/stats`);

    expect(res.status).toBe(200);
    expect(taskStatsSchema.safeParse(res.body).success).toBe(true);
    expect(Object.keys(res.body.byStatus).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("counts per status, sums needsAttention, and honours a repeated project filter", async () => {
    await makeTask({ status: "needs_qa", project: "web" });
    await makeTask({ status: "needs_user_action", project: "api" });
    await makeTask({ status: "needs_user_decision", project: "infra" });
    await makeTask({ status: "todo", project: "web" });

    const all = await request(app).get(`${BASE}/stats`);
    const some = await request(app).get(`${BASE}/stats?project=web&project=API`);

    expect(all.body.needsAttention).toBe(3);
    expect(some.body.byStatus).toMatchObject({
      needs_qa: 1,
      needs_user_action: 1,
      todo: 1,
      needs_user_decision: 0,
    });
    expect(some.body.needsAttention).toBe(2);
  });

  it("returns 422 for an unknown parameter", async () => {
    const res = await request(app).get(`${BASE}/stats`).query({ status: "todo" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------------ *
 * PATCH /tasks/:taskId
 * ------------------------------------------------------------------ */

describe("PATCH /api/v1/tasks/:taskId", () => {
  it("applies a partial update, leaves untouched fields alone, and bumps the version", async () => {
    const task = await makeTask({ title: "Original title here", priority: "low" });

    const res = await request(app).patch(`${BASE}/${task.id}`).send({ priority: "urgent" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      priority: "urgent",
      title: "Original title here",
      version: 2,
    });
  });

  it("refuses status with a message pointing at /transition", async () => {
    const task = await makeTask();

    const res = await request(app).patch(`${BASE}/${task.id}`).send({ status: "done" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(res.body.error.details).toEqual({
      status: ["Status is not PATCHable. Use POST /tasks/:taskId/transition"],
    });
  });

  it.each([
    ["an empty body", {}],
    ["expectedVersion alone", { expectedVersion: 1 }],
  ])("returns 422 AT_LEAST_ONE_FIELD with no details for %s", async (_label, body) => {
    const task = await makeTask();

    const res = await request(app).patch(`${BASE}/${task.id}`).send(body);

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "AT_LEAST_ONE_FIELD");
    expect(res.body.error.details).toBeUndefined();
  });

  it("prefers VALIDATION_ERROR over AT_LEAST_ONE_FIELD when a supplied field is invalid", async () => {
    const task = await makeTask();

    const res = await request(app).patch(`${BASE}/${task.id}`).send({ title: "x" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toEqual(["title"]);
  });

  it("returns 404 for an unknown id and for a non-numeric one", async () => {
    expect((await request(app).patch(`${BASE}/999999`).send({ priority: "low" })).status).toBe(404);

    const res = await request(app).patch(`${BASE}/abc`).send({ priority: "low" });
    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
  });

  it("returns 409 VERSION_CONFLICT with expected and current for a stale expectedVersion", async () => {
    const task = await makeTask({ version: 3 });

    const res = await request(app)
      .patch(`${BASE}/${task.id}`)
      .send({ priority: "high", expectedVersion: 2 });

    expect(res.status).toBe(409);
    expectEnvelope(res.body, "VERSION_CONFLICT");
    expect(res.body.error.details).toEqual({ expected: 2, current: 3 });
  });

  it("returns 200 without a version bump, updatedAt move, or event when nothing changes", async () => {
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const task = await makeTask({ title: "Original title here", updatedAt });

    const res = await request(app)
      .patch(`${BASE}/${task.id}`)
      .send({ title: "Original title here" });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.updatedAt).toBe(updatedAt.toISOString());
    expect(await eventsFor(task.id)).toEqual([]);
  });

  it("records task.updated with the changed fields and the X-Actor", async () => {
    const task = await makeTask({ priority: "low" });

    await request(app)
      .patch(`${BASE}/${task.id}`)
      .set("X-Actor", AGENT)
      .send({ priority: "high", assignee: "Ada" });

    expect(await eventsFor(task.id)).toEqual([
      { type: "task.updated", actor: AGENT, payload: { fields: ["priority", "assignee"] } },
    ]);
  });

  it("returns 409 TASK_ALREADY_CLAIMED to another agent, and lets a human through", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const agent = await request(app)
      .patch(`${BASE}/${task.id}`)
      .set("X-Actor", OTHER_AGENT)
      .send({ priority: "high" });
    const human = await request(app)
      .patch(`${BASE}/${task.id}`)
      .set("X-Actor", HUMAN)
      .send({ priority: "high" });

    expect(agent.status).toBe(409);
    expectEnvelope(agent.body, "TASK_ALREADY_CLAIMED");
    expect(agent.body.error.details).toEqual({
      claimedBy: AGENT,
      expiresAt: task.claimExpiresAt!.toISOString(),
    });
    expect(human.status).toBe(200);
  });

  it("rejects making a task its own ancestor on parentId", async () => {
    const root = await makeTask();
    const child = await makeTask({ parentId: root.id });

    const res = await request(app).patch(`${BASE}/${root.id}`).send({ parentId: child.id });

    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details)).toEqual(["parentId"]);
  });

  /** The empty-string-vs-null regression, asserted end to end through HTTP. */
  it("clearing assignee to '' makes the task appear under assigneeIsNull=true", async () => {
    const task = await makeTask({ assignee: "Marcus Feld" });

    const patched = await request(app).patch(`${BASE}/${task.id}`).send({ assignee: "" });
    expect(patched.body.assignee).toBeNull();

    const list = await request(app).get(BASE).query({ assigneeIsNull: "true" });
    expect(ids(list.body)).toEqual([task.id]);
  });

  it("rejects client-supplied derived fields", async () => {
    const task = await makeTask();

    for (const body of [
      { completedAt: "2026-08-11T00:00:00.000Z" },
      { createdBy: "human:x" },
      { version: 9 },
    ]) {
      const res = await request(app).patch(`${BASE}/${task.id}`).send(body);
      expect(res.status).toBe(422);
    }
  });
});

/* ------------------------------------------------------------------ *
 * DELETE /tasks/:taskId
 * ------------------------------------------------------------------ */

describe("DELETE /api/v1/tasks/:taskId", () => {
  it("returns 204 with no body, then the task is gone", async () => {
    const task = await makeTask();

    const res = await request(app).delete(`${BASE}/${task.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect((await request(app).get(`${BASE}/${task.id}`)).status).toBe(404);
  });

  it("cascades to comments, decisions, and dependency rows", async () => {
    const task = await makeTask();
    const other = await makeTask();
    await makeComment({ taskId: task.id });
    await makeDecision({ taskId: task.id });
    await makeDependency(other.id, task.id);

    await request(app).delete(`${BASE}/${task.id}`);

    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.decision.count()).toBe(0);
    expect(await prisma.taskDependency.count()).toBe(0);
  });

  it("returns 404, not 500, when the same task is deleted twice", async () => {
    const task = await makeTask();

    expect((await request(app).delete(`${BASE}/${task.id}`)).status).toBe(204);

    const second = await request(app).delete(`${BASE}/${task.id}`);
    expect(second.status).toBe(404);
    expectEnvelope(second.body, "TASK_NOT_FOUND");
  });

  it("returns 404 for a non-numeric id", async () => {
    const res = await request(app).delete(`${BASE}/abc`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
  });

  it("returns 409 TASK_ALREADY_CLAIMED when another agent holds the task", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const res = await request(app).delete(`${BASE}/${task.id}`).set("X-Actor", OTHER_AGENT);

    expect(res.status).toBe(409);
    expectEnvelope(res.body, "TASK_ALREADY_CLAIMED");
  });
});

/* ------------------------------------------------------------------ *
 * GET /tasks
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tasks", () => {
  it("returns the { data, meta } envelope with the documented defaults", async () => {
    await makeTasks(3);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(paginatedTasksSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
  });

  it("carries the summary fields on each row and no thread", async () => {
    const task = await makeTask(claimedBy(AGENT));
    const blocker = await makeTask({ status: "deferred" });
    await makeDependency(task.id, blocker.id);
    await makeComment({ taskId: task.id });
    const { task: waiting, decision } = await makeTaskAwaitingDecision();

    const res = await request(app).get(BASE).query({ sort: "id:asc" });
    const [row, , decisionRow] = res.body.data;

    expect(row).toMatchObject({
      id: task.id,
      commentCount: 1,
      openDependencyCount: 1,
      openDecision: null,
    });
    expect(row.claim).toEqual({ actor: AGENT, expiresAt: task.claimExpiresAt!.toISOString() });
    expect(row.comments).toBeUndefined();
    expect(decisionRow.id).toBe(waiting.id);
    expect(decisionRow.openDecision.id).toBe(decision.id);
  });

  it("serializes an expired claim as null", async () => {
    await makeTask(expiredClaimBy(AGENT));

    expect((await request(app).get(BASE)).body.data[0].claim).toBeNull();
  });

  it("filters by repeated status and project, ANDed", async () => {
    const match = await makeTask({ status: "todo", project: "web" });
    const alsoMatch = await makeTask({ status: "blocked", project: "api" });
    await makeTask({ status: "done", project: "web" });
    await makeTask({ status: "todo", project: "infra" });

    const res = await request(app).get(
      `${BASE}?status=todo&status=blocked&project=web&project=api`,
    );

    expect(ids(res.body).sort((a, b) => a - b)).toEqual([match.id, alsoMatch.id]);
  });

  it("filters by createdBy, claimedBy, and parentId", async () => {
    const parent = await makeTask();
    const byAgent = await makeTask({ createdBy: AGENT, parentId: parent.id });
    const held = await makeTask({ ...claimedBy(OTHER_AGENT), createdBy: HUMAN });

    expect(ids((await request(app).get(BASE).query({ createdBy: AGENT })).body)).toEqual([
      byAgent.id,
    ]);
    expect(ids((await request(app).get(BASE).query({ claimedBy: OTHER_AGENT })).body)).toEqual([
      held.id,
    ]);
    expect(
      ids(
        (
          await request(app)
            .get(BASE)
            .query({ parentId: String(parent.id) })
        ).body,
      ),
    ).toEqual([byAgent.id]);
  });

  it("returns an empty page rather than a 404 beyond the end of the results", async () => {
    await makeTasks(3);

    const res = await request(app).get(BASE).query({ page: "5" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  /** Rejected, not clamped. A client asking for 500 rows has a bug. */
  it.each([
    ["pageSize=101", { pageSize: "101" }, "pageSize"],
    ["pageSize=0", { pageSize: "0" }, "pageSize"],
    ["page=0", { page: "0" }, "page"],
    ["an unknown sort field", { sort: "nope:asc" }, "sort"],
    ["an unknown status", { status: "open" }, "status.0"],
    ["a parentId alias", { parentId: "0x2a" }, "parentId"],
    ["an over-long createdBy", { createdBy: `agent:${"a".repeat(80)}` }, "createdBy"],
  ])("returns 422 for %s, naming it in details", async (_label, query, field) => {
    const res = await request(app).get(BASE).query(query);

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  /**
   * zod reports an unrecognised key with an **empty path** (the key is named in
   * the message), and `errorHandler` files a pathless issue under `_`.
   */
  it("returns 422 for an unknown query param, naming it in the message", async () => {
    const res = await request(app).get(BASE).query({ category: "network" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body.error.details)).toContain("category");
  });

  it("returns 422 naming both params when assignee and assigneeIsNull are sent together", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ assignee: "Marcus Feld", assigneeIsNull: "true" });

    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details).sort()).toEqual(["assignee", "assigneeIsNull"]);
  });

  it("treats empty query values as absent rather than malformed", async () => {
    await makeTasks(2);

    const res = await request(app).get(`${BASE}?page=&pageSize=&status=&q=&project=&parentId=`);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 2 });
  });
});
