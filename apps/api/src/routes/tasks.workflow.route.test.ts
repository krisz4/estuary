import {
  apiErrorResponseSchema,
  nextTaskResponseSchema,
  SYSTEM_ACTOR,
  taskSchema,
} from "@estuary/contracts";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  eventsFor,
  expireClaim,
  makeDependency,
  makeTask,
  makeTaskAwaitingDecision,
  makeTasks,
} from "../test/factories.js";

/**
 * The workflow endpoints through HTTP — transition, claim, heartbeat, release,
 * next, decision/answer, dependencies (`docs/features/Task_Workflow_API.md`).
 *
 * The rules themselves are asserted against the service in
 * `services/task-workflow.service.test.ts`. What is asserted here is the HTTP
 * half: that each target status's required payload fails as a per-field 422,
 * that `X-Actor` is what the rules key off, that bodies are optional where the
 * spec says so, and that every failure arrives as the documented code.
 */

const app = createApp();

const BASE = "/api/v1/tasks";
const AGENT = "agent:claude-code";
const OTHER_AGENT = "agent:codex";
const HUMAN = "human:krisz";

const expectError = (res: request.Response, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const parsed = apiErrorResponseSchema.safeParse(res.body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(res.body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
};

const post = (path: string, actor: string, body?: object) => {
  const req = request(app).post(`${BASE}${path}`).set("X-Actor", actor);
  return body === undefined ? req : req.send(body);
};

const transition = (id: number, body: object, actor = HUMAN) =>
  post(`/${id}/transition`, actor, body);

/* ------------------------------------------------------------------ *
 * POST /tasks/:taskId/transition
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/:taskId/transition", () => {
  it("returns 200 with the task in its new status, satisfying taskSchema", async () => {
    const task = await makeTask({ status: "todo" });

    const res = await transition(task.id, { to: "blocked", reason: "Waiting on infra" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "blocked",
      statusNote: "Waiting on infra",
      version: 2,
    });
    expect(taskSchema.safeParse(res.body).success).toBe(true);
  });

  /** What each status requires is the shape of its payload — a per-field 422. */
  it.each([
    ["needs_refinement without a reason", { to: "needs_refinement" }, "reason"],
    ["blocked with neither reason nor blockedBy", { to: "blocked" }, "reason"],
    ["blocked with an empty blockedBy", { to: "blocked", blockedBy: [] }, "reason"],
    ["needs_user_decision without a decision", { to: "needs_user_decision" }, "decision"],
    [
      "needs_user_decision with one option",
      {
        to: "needs_user_decision",
        decision: { question: "Keep it?", options: [{ label: "Yes" }] },
      },
      "decision.options",
    ],
    [
      "needs_user_decision recommending an option it did not offer",
      {
        to: "needs_user_decision",
        decision: {
          question: "Keep it?",
          options: [{ label: "Yes" }, { label: "No" }],
          recommendedOption: "Maybe",
        },
      },
      "decision.recommendedOption",
    ],
    ["needs_user_action without instructions", { to: "needs_user_action" }, "instructions"],
    ["needs_qa without a summary", { to: "needs_qa" }, "summary"],
    [
      "needs_qa with a bad link",
      { to: "needs_qa", summary: "Done", links: [{ label: "PR", url: "x" }] },
      "links.0.url",
    ],
    ["deferred without a reason", { to: "deferred" }, "reason"],
    ["deferred with a blank reason", { to: "deferred", reason: "   " }, "reason"],
    ["a field another target owns", { to: "todo", instructions: "Do it" }, "_"],
    ["an unknown status", { to: "resolved" }, "to"],
  ])("returns 422 for %s, on %s", async (_label, body, field) => {
    const task = await makeTask({ status: "in_progress" });

    const res = await transition(task.id, body);

    expectError(res, 422, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version).toBe(1);
  });

  it("returns 422 on acceptanceCriteria for todo when none are stored or supplied", async () => {
    const task = await makeTask({ status: "needs_refinement", acceptanceCriteria: null });

    const res = await transition(task.id, { to: "todo" });

    expectError(res, 422, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toEqual(["acceptanceCriteria"]);
  });

  it("returns 422 on blockedBy for a self-dependency or a missing task, and 409 for a cycle", async () => {
    const task = await makeTask({ status: "in_progress" });
    const other = await makeTask();
    await makeDependency(other.id, task.id);

    const self = await transition(task.id, { to: "blocked", blockedBy: [task.id] });
    const missing = await transition(task.id, { to: "blocked", blockedBy: [9999] });
    const cycle = await transition(task.id, { to: "blocked", blockedBy: [other.id] });

    expectError(self, 422, "VALIDATION_ERROR");
    expect(Object.keys(self.body.error.details)).toEqual(["blockedBy"]);
    expectError(missing, 422, "VALIDATION_ERROR");
    expectError(cycle, 409, "DEPENDENCY_CYCLE");
    expect(cycle.body.error.details).toEqual({ path: [task.id, other.id, task.id] });
  });

  describe("an agent moving a task to done", () => {
    const original = env.AGENTS_MAY_COMPLETE;
    afterEach(() => {
      env.AGENTS_MAY_COMPLETE = original;
    });

    it("is 403 ACTOR_NOT_PERMITTED by default, while a human may", async () => {
      env.AGENTS_MAY_COMPLETE = false;
      const task = await makeTask({ status: "needs_qa" });

      expectError(await transition(task.id, { to: "done" }, AGENT), 403, "ACTOR_NOT_PERMITTED");
      expect((await transition(task.id, { to: "done" }, HUMAN)).status).toBe(200);
    });

    it("is allowed when the server runs with AGENTS_MAY_COMPLETE", async () => {
      env.AGENTS_MAY_COMPLETE = true;
      const task = await makeTask({ status: "needs_qa" });

      expect((await transition(task.id, { to: "done" }, AGENT)).body.status).toBe("done");
    });
  });

  it("returns 409 TASK_ALREADY_CLAIMED to another agent", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const res = await transition(task.id, { to: "todo" }, OTHER_AGENT);

    expectError(res, 409, "TASK_ALREADY_CLAIMED");
    expect(res.body.error.details.claimedBy).toBe(AGENT);
  });

  it("returns 409 VERSION_CONFLICT for a stale expectedVersion", async () => {
    const task = await makeTask({ status: "todo" });

    const res = await transition(task.id, { to: "in_progress", expectedVersion: 5 });

    expectError(res, 409, "VERSION_CONFLICT");
    expect(res.body.error.details).toEqual({ expected: 5, current: 1 });
  });

  it("returns 404 for an unknown or non-numeric id", async () => {
    expectError(await transition(999, { to: "todo" }), 404, "TASK_NOT_FOUND");
    expectError(await post("/abc/transition", HUMAN, { to: "todo" }), 404, "TASK_NOT_FOUND");
  });

  it("unblocks dependents on done, attributing the unblock to the system", async () => {
    const blocker = await makeTask({ status: "needs_qa" });
    const waiter = await makeTask({ status: "blocked" });
    await makeDependency(waiter.id, blocker.id);

    await transition(blocker.id, { to: "done" });

    const res = await request(app).get(`${BASE}/${waiter.id}`);
    expect(res.body.status).toBe("todo");
    expect((await eventsFor(waiter.id)).at(-1)?.actor).toBe(SYSTEM_ACTOR);
  });
});

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/:taskId/claim", () => {
  it("claims with no body at all", async () => {
    const task = await makeTask({ status: "todo" });

    const res = await post(`/${task.id}/claim`, AGENT);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.claim.actor).toBe(AGENT);
  });

  it("returns 409 TASK_ALREADY_CLAIMED with the holder and expiry to a second agent", async () => {
    const task = await makeTask({ status: "todo" });
    const first = await post(`/${task.id}/claim`, AGENT, {});

    const res = await post(`/${task.id}/claim`, OTHER_AGENT, {});

    expectError(res, 409, "TASK_ALREADY_CLAIMED");
    expect(res.body.error.details).toEqual({
      claimedBy: AGENT,
      expiresAt: first.body.claim.expiresAt,
    });
  });

  it("lets anyone claim once the lease has run out", async () => {
    const task = await makeTask({ status: "todo" });
    await post(`/${task.id}/claim`, AGENT, {});
    await expireClaim(task.id);

    expect((await request(app).get(`${BASE}/${task.id}`)).body.claim).toBeNull();
    expect((await post(`/${task.id}/claim`, OTHER_AGENT, {})).body.claim.actor).toBe(OTHER_AGENT);
  });

  it("validates the body strictly", async () => {
    const task = await makeTask({ status: "todo" });

    expectError(
      await post(`/${task.id}/claim`, AGENT, { expectedVersion: "one" }),
      422,
      "VALIDATION_ERROR",
    );
    expectError(await post(`/${task.id}/claim`, AGENT, { force: true }), 422, "VALIDATION_ERROR");
  });
});

describe("POST /api/v1/tasks/:taskId/heartbeat", () => {
  it("extends the holder's lease without bumping the version", async () => {
    const task = await makeTask(claimedBy(AGENT, 1));

    const res = await post(`/${task.id}/heartbeat`, AGENT);

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(task.version);
    expect(new Date(res.body.claim.expiresAt).getTime()).toBeGreaterThan(
      task.claimExpiresAt!.getTime(),
    );
  });

  it("returns 409 NOT_CLAIM_HOLDER to anyone else", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const res = await post(`/${task.id}/heartbeat`, OTHER_AGENT);

    expectError(res, 409, "NOT_CLAIM_HOLDER");
    expect(res.body.error.details.claimedBy).toBe(AGENT);
  });

  it("returns 404 for an unknown task", async () => {
    expectError(await post("/999/heartbeat", AGENT), 404, "TASK_NOT_FOUND");
  });
});

describe("POST /api/v1/tasks/:taskId/release", () => {
  it("returns the holder's task to todo, with or without a body", async () => {
    const [a, b] = await makeTasks(2, () => claimedBy(AGENT));

    const withReason = await post(`/${a!.id}/release`, AGENT, { reason: "Handing off" });
    const bare = await post(`/${b!.id}/release`, AGENT);

    expect(withReason.body).toMatchObject({
      status: "todo",
      claim: null,
      statusNote: "Handing off",
    });
    expect(bare.body).toMatchObject({ status: "todo", claim: null, statusNote: null });
  });

  it("lets a human release an agent's claim and refuses another agent", async () => {
    const task = await makeTask(claimedBy(AGENT));

    expectError(await post(`/${task.id}/release`, OTHER_AGENT), 409, "NOT_CLAIM_HOLDER");
    expect((await post(`/${task.id}/release`, HUMAN)).status).toBe(200);
  });

  it("returns 409 VERSION_CONFLICT for a stale expectedVersion", async () => {
    const task = await makeTask(claimedBy(AGENT));

    expectError(
      await post(`/${task.id}/release`, AGENT, { expectedVersion: 7 }),
      409,
      "VERSION_CONFLICT",
    );
  });
});

/* ------------------------------------------------------------------ *
 * POST /tasks/next
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/next", () => {
  it("returns { task: null } with 200 when nothing is available — with or without a body", async () => {
    const bare = await post("/next", AGENT);
    const empty = await post("/next", AGENT, {});

    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ task: null });
    expect(empty.body).toEqual({ task: null });
  });

  it("claims the best task for the X-Actor, highest priority then oldest", async () => {
    await makeTask({ status: "todo", priority: "low", createdAt: new Date("2026-01-01") });
    const urgent = await makeTask({
      status: "todo",
      priority: "urgent",
      createdAt: new Date("2026-03-01"),
    });

    const res = await post("/next", AGENT, {});

    expect(nextTaskResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.task).toMatchObject({ id: urgent.id, status: "in_progress" });
    expect(res.body.task.claim.actor).toBe(AGENT);
  });

  it("honours project and minPriority, lowercasing the project", async () => {
    await makeTask({ status: "todo", project: "web", priority: "urgent" });
    const api = await makeTask({ status: "todo", project: "api", priority: "high" });
    await makeTask({ status: "todo", project: "api", priority: "low" });

    const res = await post("/next", AGENT, { project: ["API"], minPriority: "high" });

    expect(res.body.task.id).toBe(api.id);
    expect((await post("/next", AGENT, { project: ["api"], minPriority: "high" })).body).toEqual({
      task: null,
    });
  });

  it("returns 422 for an unknown field or an empty project list", async () => {
    expectError(await post("/next", AGENT, { status: "todo" }), 422, "VALIDATION_ERROR");
    expectError(await post("/next", AGENT, { project: [] }), 422, "VALIDATION_ERROR");
  });

  it("hands each task to exactly one of many agents calling at once", async () => {
    await makeTasks(4, () => ({ status: "todo" }));

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post("/next", `agent:worker-${i}`, {})),
    );

    expect(responses.every((res) => res.status === 200)).toBe(true);
    const handed = responses.map((res) => res.body.task).filter((task) => task !== null);
    expect(handed).toHaveLength(4);
    expect(new Set(handed.map((task: { id: number }) => task.id)).size).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * POST /tasks/:taskId/decision/answer
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/:taskId/decision/answer", () => {
  it("records the answer and returns the task in todo with the answer as its note", async () => {
    const { task, decision } = await makeTaskAwaitingDecision();

    const res = await post(`/${task.id}/decision/answer`, HUMAN, {
      choice: "Keep the endpoint",
      note: "for one more release",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("todo");
    expect(res.body.statusNote).toBe("Decision: Keep the endpoint — for one more release");
    expect(res.body.decisions[0]).toMatchObject({
      id: decision.id,
      status: "answered",
      choice: "Keep the endpoint",
      note: "for one more release",
      answeredBy: HUMAN,
    });
  });

  it("returns 422 on choice for an option that was not offered, and for an empty body", async () => {
    const { task } = await makeTaskAwaitingDecision();

    const wrong = await post(`/${task.id}/decision/answer`, HUMAN, {
      choice: "Rewrite it in Rust",
    });
    const empty = await post(`/${task.id}/decision/answer`, HUMAN, {});

    expectError(wrong, 422, "VALIDATION_ERROR");
    expect(Object.keys(wrong.body.error.details)).toEqual(["choice"]);
    expectError(empty, 422, "VALIDATION_ERROR");
    expect(Object.keys(empty.body.error.details)).toEqual(["choice"]);
  });

  it("returns 409 NO_OPEN_DECISION when the task is not waiting on one", async () => {
    const task = await makeTask({ status: "todo" });

    expectError(
      await post(`/${task.id}/decision/answer`, HUMAN, { note: "Yes" }),
      409,
      "NO_OPEN_DECISION",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/:taskId/dependencies", () => {
  it("adds the dependency and returns the task with it, idempotently", async () => {
    const task = await makeTask();
    const blocker = await makeTask();

    const first = await post(`/${task.id}/dependencies`, HUMAN, { dependsOnId: blocker.id });
    const again = await post(`/${task.id}/dependencies`, HUMAN, { dependsOnId: blocker.id });

    expect(first.status).toBe(200);
    expect(first.body.dependencies.map((d: { id: number }) => d.id)).toEqual([blocker.id]);
    expect(first.body.openDependencyCount).toBe(1);
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(first.body.version);
  });

  it("returns 422 on dependsOnId for self, missing, and non-integer values", async () => {
    const task = await makeTask();

    for (const dependsOnId of [task.id, 9999, "2", 0]) {
      const res = await post(`/${task.id}/dependencies`, HUMAN, { dependsOnId });
      expectError(res, 422, "VALIDATION_ERROR");
      expect(Object.keys(res.body.error.details)).toEqual(["dependsOnId"]);
    }
  });

  it("returns 409 DEPENDENCY_CYCLE with the loop in details.path", async () => {
    const [a, b, c] = await makeTasks(3);
    await makeDependency(b!.id, c!.id);
    await makeDependency(c!.id, a!.id);

    const res = await post(`/${a!.id}/dependencies`, HUMAN, { dependsOnId: b!.id });

    expectError(res, 409, "DEPENDENCY_CYCLE");
    expect(res.body.error.details).toEqual({ path: [a!.id, b!.id, c!.id, a!.id] });
  });

  it("returns 404 when the task itself is missing", async () => {
    const blocker = await makeTask();
    expectError(
      await post("/999/dependencies", HUMAN, { dependsOnId: blocker.id }),
      404,
      "TASK_NOT_FOUND",
    );
  });
});

describe("DELETE /api/v1/tasks/:taskId/dependencies/:dependsOnId", () => {
  it("returns 200 with the task, and unblocks it when the last open blocker goes", async () => {
    const task = await makeTask({ status: "blocked" });
    const blocker = await makeTask({ status: "in_progress" });
    await makeDependency(task.id, blocker.id);

    const res = await request(app)
      .delete(`${BASE}/${task.id}/dependencies/${blocker.id}`)
      .set("X-Actor", HUMAN);

    expect(res.status).toBe(200);
    expect(res.body.dependencies).toEqual([]);
    expect(res.body.status).toBe("todo");
  });

  it("is a no-op 200 for an edge that does not exist", async () => {
    const task = await makeTask();

    const res = await request(app).delete(`${BASE}/${task.id}/dependencies/12345`);

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
  });

  it("returns 404 TASK_NOT_FOUND for a non-numeric dependsOnId, like any id segment", async () => {
    const task = await makeTask();

    expectError(
      await request(app).delete(`${BASE}/${task.id}/dependencies/abc`),
      404,
      "TASK_NOT_FOUND",
    );
  });

  it("returns 409 TASK_ALREADY_CLAIMED to an agent that does not hold the task", async () => {
    const task = await makeTask(claimedBy(AGENT));
    const blocker = await makeTask();
    await makeDependency(task.id, blocker.id);

    const res = await request(app)
      .delete(`${BASE}/${task.id}/dependencies/${blocker.id}`)
      .set("X-Actor", OTHER_AGENT);

    expectError(res, 409, "TASK_ALREADY_CLAIMED");
  });
});
