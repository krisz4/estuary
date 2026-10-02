import {
  createTaskInputSchema,
  hasAtLeastOneField,
  TASK_STATUSES,
  taskSchema,
  updateTaskInputSchema,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  eventsFor,
  expiredClaimBy,
  makeComment,
  makeDecision,
  makeDependency,
  makeTask,
} from "../test/factories.js";
import {
  createTask,
  deleteTask,
  getTask,
  getTaskFacets,
  getTaskStats,
  updateTask,
} from "./task.service.js";

/**
 * Service tests against a real (temp) SQLite file for task CRUD, facets, and
 * stats — `docs/features/Task_Workflow_API.md` and `docs/engineering/TESTING.md`
 * § Tasks. Status changes, claims, `next`, decisions, and dependencies are in
 * `task-workflow.service.test.ts`.
 *
 * Two conventions worth stating, because they are what make these tests able to
 * fail:
 *
 * 1. **Input is parsed through the contract schemas**, exactly as the route will
 *    do it. `assignee: ""` becoming `null` and `project` being lowercased are
 *    schema transforms, and a test that handed the service a pre-cooked value
 *    would assert nothing about the path a client actually takes.
 * 2. **Rank columns are asserted by sorting, never by reading the column.**
 */

const HUMAN = "human:krisz";
const AGENT = "agent:claude-code";
const OTHER_AGENT = "agent:codex";

/* ------------------------------------------------------------------ *
 * Input helpers — the real schemas, not hand-built objects
 * ------------------------------------------------------------------ */

const createInput = (overrides: Record<string, unknown> = {}): CreateTaskInput =>
  createTaskInputSchema.parse({
    title: "Add retries to the webhook sender",
    description: "Deliveries fail permanently on the first 502 from the receiver.",
    ...overrides,
  });

const updateInput = (input: Record<string, unknown>): UpdateTaskInput =>
  updateTaskInputSchema.parse(input);

/** Assert a thrown value is our `ApiError` with the expected code and status. */
const expectApiError = async (
  run: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> => {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  // `toBeInstanceOf(ApiError)` also rules out a raw Prisma error leaking
  // through — the difference between an explicit check and a `P2025`/`P2003`
  // that happens to be mapped (or not) downstream.
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  return error;
};

const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

describe("createTask", () => {
  it("returns an integer id, its reference, the backlog/medium defaults, and version 1", async () => {
    const { task, created } = await createTask(createInput(), HUMAN);

    expect(created).toBe(true);
    expect(Number.isInteger(task.id)).toBe(true);
    expect(task.reference).toBe(`TASK-${String(task.id).padStart(6, "0")}`);
    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("medium");
    expect(task.version).toBe(1);
    expect(task.claim).toBeNull();
    expect(task.startedAt).toBeNull();
    expect(taskSchema.safeParse(task).success).toBe(true);
  });

  it("records the acting actor as createdBy", async () => {
    const { task } = await createTask(createInput(), AGENT);
    expect(task.createdBy).toBe(AGENT);
  });

  it.each(["backlog", "needs_refinement", "todo"] as const)(
    "accepts %s as an initial status",
    async (status) => {
      const { task } = await createTask(
        createInput({ status, acceptanceCriteria: "Retries three times with backoff" }),
        HUMAN,
      );
      expect(task.status).toBe(status);
    },
  );

  it.each(TASK_STATUSES.filter((s) => !["backlog", "needs_refinement", "todo"].includes(s)))(
    "rejects %s as an initial status at the contract boundary",
    (status) => {
      const result = createTaskInputSchema.safeParse({ ...createInput(), status });
      expect(result.success).toBe(false);
    },
  );

  it("requires acceptance criteria to create straight into todo", () => {
    const result = createTaskInputSchema.safeParse({
      title: "Add retries to the webhook sender",
      description: "Deliveries fail permanently on the first 502.",
      status: "todo",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "acceptanceCriteria",
    ]);
  });

  it("lowercases the project so filtering by it is exact", async () => {
    const { task } = await createTask(createInput({ project: "  Estuary " }), HUMAN);
    expect(task.project).toBe("estuary");
  });

  it("stores an empty assignee, project, and acceptance criteria as null", async () => {
    const { task } = await createTask(
      createInput({ assignee: "", project: "   ", acceptanceCriteria: "" }),
      HUMAN,
    );

    expect(task.assignee).toBeNull();
    expect(task.project).toBeNull();
    expect(task.acceptanceCriteria).toBeNull();
  });

  it("writes a task.created event with the status and title", async () => {
    const { task } = await createTask(createInput({ status: "needs_refinement" }), AGENT);

    expect(await eventsFor(task.id)).toEqual([
      {
        type: "task.created",
        actor: AGENT,
        payload: { status: "needs_refinement", title: "Add retries to the webhook sender" },
      },
    ]);
  });

  describe("idempotencyKey", () => {
    it("returns the original task, unchanged, for a repeated key — even with a different body", async () => {
      const first = await createTask(
        createInput({ idempotencyKey: "cc:repo:webhook-retries" }),
        AGENT,
      );

      const replay = await createTask(
        createInput({
          idempotencyKey: "cc:repo:webhook-retries",
          title: "A completely different title",
          priority: "urgent",
        }),
        OTHER_AGENT,
      );

      expect(replay.created).toBe(false);
      expect(replay.task.id).toBe(first.task.id);
      expect(replay.task.title).toBe("Add retries to the webhook sender");
      expect(replay.task.priority).toBe("medium");
      expect(replay.task.createdBy).toBe(AGENT);
      expect(await prisma.task.count()).toBe(1);
      // A replay records nothing: nothing happened.
      expect((await eventsFor(first.task.id)).map((e) => e.type)).toEqual(["task.created"]);
    });

    it("creates two tasks for two different keys", async () => {
      await createTask(createInput({ idempotencyKey: "key-a" }), AGENT);
      await createTask(createInput({ idempotencyKey: "key-b" }), AGENT);

      expect(await prisma.task.count()).toBe(2);
    });

    it("files exactly one task when the same key races itself", async () => {
      // Both calls can miss the pre-read; the unique index decides, and the
      // loser's P2002 must come back as a replay rather than a 500.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          createTask(createInput({ idempotencyKey: "racing-key" }), AGENT),
        ),
      );

      expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(await prisma.task.count()).toBe(1);
    });

    describe("against a closed task", () => {
      it("creates a new task (201) rather than replaying a done task, and retires the key from it", async () => {
        const original = await makeTask({ status: "done", idempotencyKey: "recycled-key" });

        const result = await createTask(createInput({ idempotencyKey: "recycled-key" }), AGENT);

        expect(result.created).toBe(true);
        expect(result.task.id).not.toBe(original.id);
        expect(await prisma.task.count()).toBe(2);

        const retired = await prisma.task.findUniqueOrThrow({ where: { id: original.id } });
        expect(retired.idempotencyKey).toBeNull();
        // Retiring the key is bookkeeping, not a content change: no version
        // bump, and no event recorded for it (the factory wrote `original`
        // directly, so its event trail starts empty and stays that way).
        expect(retired.version).toBe(1);
        expect(await eventsFor(original.id)).toEqual([]);

        const newRow = await prisma.task.findUniqueOrThrow({ where: { id: result.task.id } });
        expect(newRow.idempotencyKey).toBe("recycled-key");
      });

      it("creates a new task rather than replaying a deferred task", async () => {
        const original = await makeTask({ status: "deferred", idempotencyKey: "deferred-key" });

        const result = await createTask(createInput({ idempotencyKey: "deferred-key" }), AGENT);

        expect(result.created).toBe(true);
        expect(result.task.id).not.toBe(original.id);
      });

      it("still replays (200) against an open task holding the key, even one it later shares nothing else with", async () => {
        const original = await makeTask({ status: "todo", idempotencyKey: "open-key" });

        const replay = await createTask(createInput({ idempotencyKey: "open-key" }), AGENT);

        expect(replay.created).toBe(false);
        expect(replay.task.id).toBe(original.id);
        expect(await prisma.task.count()).toBe(1);
      });
    });
  });

  describe("parentId", () => {
    it("links a subtask to an existing parent", async () => {
      const parent = await makeTask();

      const { task } = await createTask(createInput({ parentId: parent.id }), HUMAN);

      expect(task.parentId).toBe(parent.id);
      expect(task.parent).toMatchObject({ id: parent.id, reference: "TASK-000001" });
      expect((await getTask(parent.id)).children.map((child) => child.id)).toEqual([task.id]);
    });

    it("rejects a parent that does not exist on the parentId field, writing nothing", async () => {
      const error = await expectApiError(
        () => createTask(createInput({ parentId: 999 }), HUMAN),
        "VALIDATION_ERROR",
        422,
      );

      expect(error.details).toEqual({ parentId: ["Task 999 does not exist"] });
      expect(await prisma.task.count()).toBe(0);
      expect(await prisma.taskEvent.count()).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

describe("getTask", () => {
  it("returns the task with its comments oldest-first", async () => {
    const task = await makeTask();
    await makeComment({
      taskId: task.id,
      body: "first",
      createdAt: new Date("2026-08-11T09:00:00Z"),
    });
    await makeComment({
      taskId: task.id,
      body: "second",
      createdAt: new Date("2026-08-11T10:00:00Z"),
    });

    const loaded = await getTask(task.id);

    expect(loaded.comments.map((comment) => comment.body)).toEqual(["first", "second"]);
    expect(loaded.commentCount).toBe(2);
  });

  it("orders comments created in the same millisecond by insertion order", async () => {
    const task = await makeTask();
    const sameMs = new Date("2026-08-11T09:00:00.000Z");
    for (const body of ["one", "two", "three"]) {
      await makeComment({ taskId: task.id, body, createdAt: sameMs });
    }

    expect((await getTask(task.id)).comments.map((comment) => comment.body)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("loads parent, children, dependencies, and dependents as task refs", async () => {
    const parent = await makeTask({ title: "Parent epic here" });
    const task = await makeTask({ parentId: parent.id, status: "blocked" });
    const child = await makeTask({ parentId: task.id });
    const blocker = await makeTask({ status: "in_progress" });
    const waiter = await makeTask({ status: "blocked" });
    await makeDependency(task.id, blocker.id);
    await makeDependency(waiter.id, task.id);

    const loaded = await getTask(task.id);

    expect(loaded.parent).toEqual({
      id: parent.id,
      reference: "TASK-000001",
      title: "Parent epic here",
      status: "backlog",
      project: null,
    });
    expect(loaded.children.map((ref) => ref.id)).toEqual([child.id]);
    expect(loaded.dependencies).toEqual([
      expect.objectContaining({ id: blocker.id, status: "in_progress" }),
    ]);
    expect(loaded.dependents.map((ref) => ref.id)).toEqual([waiter.id]);
    expect(loaded.openDependencyCount).toBe(1);
  });

  it("serializes dates as ISO strings and omits storage columns", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const loaded = await getTask(task.id);

    expect(loaded.createdAt).toBe(task.createdAt.toISOString());
    expect(loaded.claim).toEqual({ actor: AGENT, expiresAt: task.claimExpiresAt!.toISOString() });
    for (const column of [
      "statusRank",
      "priorityRank",
      "idempotencyKey",
      "claimedBy",
      "claimExpiresAt",
    ]) {
      expect(loaded).not.toHaveProperty(column);
    }
    expect(taskSchema.safeParse(loaded).success).toBe(true);
  });

  it("serializes an expired lease as claim: null", async () => {
    const task = await makeTask(expiredClaimBy(AGENT));
    expect((await getTask(task.id)).claim).toBeNull();
  });

  it("throws TASK_NOT_FOUND for an id that does not exist", async () => {
    await expectApiError(() => getTask(999), "TASK_NOT_FOUND", 404);
  });
});

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

describe("updateTask", () => {
  it("leaves untouched fields alone on a partial update and bumps the version", async () => {
    const task = await makeTask({ title: "Original title here", priority: "low", project: "web" });

    const updated = await updateTask(task.id, updateInput({ priority: "urgent" }), HUMAN);

    expect(updated.priority).toBe("urgent");
    expect(updated.title).toBe("Original title here");
    expect(updated.project).toBe("web");
    expect(updated.version).toBe(2);
  });

  it("clears the assignee to null when it is patched to an empty string", async () => {
    const task = await makeTask({ assignee: "Marcus Feld" });

    const updated = await updateTask(task.id, updateInput({ assignee: "" }), HUMAN);

    expect(updated.assignee).toBeNull();
  });

  it("keeps the priority rank in step with the priority it patched", async () => {
    const task = await makeTask({ priority: "low" });
    await makeTask({ priority: "high" });

    await updateTask(task.id, updateInput({ priority: "urgent" }), HUMAN);

    const ordered = await prisma.task.findMany({ orderBy: { priorityRank: "desc" } });
    expect(ordered.map((row) => row.id)).toEqual([task.id, 2]);
  });

  it("records a task.updated event listing exactly the fields that changed", async () => {
    const task = await makeTask({ title: "Original title here", priority: "low" });

    await updateTask(
      task.id,
      updateInput({ title: "Original title here", priority: "high", project: "api" }),
      AGENT,
    );

    expect(await eventsFor(task.id)).toEqual([
      { type: "task.updated", actor: AGENT, payload: { fields: ["priority", "project"] } },
    ]);
  });

  it("performs no write at all when every field equals its stored value", async () => {
    const task = await makeTask({
      title: "Original title here",
      priority: "low",
      links: [{ label: "PR", url: "https://example.com/pr/1" }],
      updatedAt: LONG_AGO,
    });

    const result = await updateTask(
      task.id,
      updateInput({
        title: "Original title here",
        priority: "low",
        links: [{ label: "PR", url: "https://example.com/pr/1" }],
      }),
      HUMAN,
    );

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(result.version).toBe(1);
    expect(after.version).toBe(1);
    expect(after.updatedAt.toISOString()).toBe(LONG_AGO.toISOString());
    expect(await eventsFor(task.id)).toEqual([]);
  });

  it("moves updatedAt when a field genuinely changes", async () => {
    const task = await makeTask({ updatedAt: LONG_AGO });

    const updated = await updateTask(task.id, updateInput({ priority: "high" }), HUMAN);

    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("treats { expectedVersion } alone as carrying no field", () => {
    expect(hasAtLeastOneField(updateInput({ expectedVersion: 1 }))).toBe(false);
    expect(hasAtLeastOneField(updateInput({}))).toBe(false);
    expect(hasAtLeastOneField(updateInput({ priority: "low" }))).toBe(true);
  });

  it("rejects status at the contract boundary — status goes through /transition", () => {
    expect(updateTaskInputSchema.safeParse({ status: "done" }).success).toBe(false);
  });

  describe("expectedVersion", () => {
    it("succeeds when it matches", async () => {
      const task = await makeTask({ version: 4 });

      const updated = await updateTask(
        task.id,
        updateInput({ priority: "high", expectedVersion: 4 }),
        HUMAN,
      );

      expect(updated.version).toBe(5);
    });

    it("throws VERSION_CONFLICT with expected and current when it does not, writing nothing", async () => {
      const task = await makeTask({ version: 3, priority: "low" });

      const error = await expectApiError(
        () => updateTask(task.id, updateInput({ priority: "high", expectedVersion: 2 }), HUMAN),
        "VERSION_CONFLICT",
        409,
      );

      expect(error.details).toEqual({ expected: 2, current: 3 });
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).priority).toBe(
        "low",
      );
      expect(await eventsFor(task.id)).toEqual([]);
    });

    it("is checked even when the body would change nothing", async () => {
      const task = await makeTask({ version: 3, priority: "low" });

      await expectApiError(
        () => updateTask(task.id, updateInput({ priority: "low", expectedVersion: 1 }), HUMAN),
        "VERSION_CONFLICT",
        409,
      );
    });
  });

  describe("claims", () => {
    it("refuses an agent other than the holder with TASK_ALREADY_CLAIMED and who holds it", async () => {
      const task = await makeTask(claimedBy(AGENT));

      const error = await expectApiError(
        () => updateTask(task.id, updateInput({ priority: "high" }), OTHER_AGENT),
        "TASK_ALREADY_CLAIMED",
        409,
      );

      expect(error.details).toEqual({
        claimedBy: AGENT,
        expiresAt: task.claimExpiresAt!.toISOString(),
      });
    });

    it("lets a human override a live agent claim", async () => {
      const task = await makeTask(claimedBy(AGENT));

      const updated = await updateTask(task.id, updateInput({ priority: "high" }), HUMAN);

      expect(updated.priority).toBe("high");
      // Editing does not take the task away from the agent.
      expect(updated.claim?.actor).toBe(AGENT);
    });

    it("lets any agent write once the lease has expired", async () => {
      const task = await makeTask(expiredClaimBy(AGENT));

      const updated = await updateTask(task.id, updateInput({ priority: "high" }), OTHER_AGENT);

      expect(updated.priority).toBe("high");
    });

    it("renews the holder's lease on its own write", async () => {
      const task = await makeTask(claimedBy(AGENT, 1));

      const updated = await updateTask(task.id, updateInput({ priority: "high" }), AGENT);

      expect(new Date(updated.claim!.expiresAt).getTime()).toBeGreaterThan(
        task.claimExpiresAt!.getTime() + 60_000,
      );
    });
  });

  describe("parentId", () => {
    it("rejects making a task its own parent", async () => {
      const task = await makeTask();

      const error = await expectApiError(
        () => updateTask(task.id, updateInput({ parentId: task.id }), HUMAN),
        "VALIDATION_ERROR",
        422,
      );
      expect(Object.keys(error.details as object)).toEqual(["parentId"]);
    });

    it("rejects making a task a child of its own descendant", async () => {
      const root = await makeTask();
      const child = await makeTask({ parentId: root.id });
      const grandchild = await makeTask({ parentId: child.id });

      const error = await expectApiError(
        () => updateTask(root.id, updateInput({ parentId: grandchild.id }), HUMAN),
        "VALIDATION_ERROR",
        422,
      );

      expect(error.details).toEqual({ parentId: ["That would make the task its own ancestor"] });
      expect((await prisma.task.findUniqueOrThrow({ where: { id: root.id } })).parentId).toBeNull();
    });

    it("rejects a parent that does not exist", async () => {
      const task = await makeTask();

      await expectApiError(
        () => updateTask(task.id, updateInput({ parentId: 999 }), HUMAN),
        "VALIDATION_ERROR",
        422,
      );
    });

    it("detaches a subtask with parentId: null", async () => {
      const parent = await makeTask();
      const task = await makeTask({ parentId: parent.id });

      const updated = await updateTask(task.id, updateInput({ parentId: null }), HUMAN);

      expect(updated.parentId).toBeNull();
      expect(updated.parent).toBeNull();
    });
  });

  it("throws TASK_NOT_FOUND for an unknown id instead of surfacing a Prisma error", async () => {
    await expectApiError(
      () => updateTask(999, updateInput({ priority: "high" }), HUMAN),
      "TASK_NOT_FOUND",
      404,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

describe("deleteTask", () => {
  it("removes the task and cascades its comments, decisions, and dependency rows", async () => {
    const task = await makeTask();
    const other = await makeTask();
    await makeComment({ taskId: task.id });
    await makeDecision({ taskId: task.id });
    await makeDependency(task.id, other.id);
    await makeDependency(other.id, task.id);

    await deleteTask(task.id, HUMAN);

    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.decision.count()).toBe(0);
    expect(await prisma.taskDependency.count()).toBe(0);
    expect(await prisma.task.count()).toBe(1);
  });

  it("keeps the task's events and appends task.deleted with its title", async () => {
    const { task } = await createTask(createInput(), HUMAN);

    await deleteTask(task.id, AGENT);

    expect(await eventsFor(task.id)).toEqual([
      expect.objectContaining({ type: "task.created" }),
      {
        type: "task.deleted",
        actor: AGENT,
        payload: { title: "Add retries to the webhook sender" },
      },
    ]);
  });

  it("refuses an agent that does not hold the live claim", async () => {
    const task = await makeTask(claimedBy(AGENT));

    await expectApiError(() => deleteTask(task.id, OTHER_AGENT), "TASK_ALREADY_CLAIMED", 409);
    expect(await prisma.task.count()).toBe(1);
  });

  it("lets a human delete a claimed task", async () => {
    const task = await makeTask(claimedBy(AGENT));

    await deleteTask(task.id, HUMAN);

    expect(await prisma.task.count()).toBe(0);
  });

  it("throws TASK_NOT_FOUND on a second delete rather than a Prisma error", async () => {
    const task = await makeTask();
    await deleteTask(task.id, HUMAN);

    await expectApiError(() => deleteTask(task.id, HUMAN), "TASK_NOT_FOUND", 404);
  });
});

/* ------------------------------------------------------------------ *
 * Facets
 * ------------------------------------------------------------------ */

describe("getTaskFacets", () => {
  it("returns distinct non-null assignees, projects, labels, and creators, sorted", async () => {
    const web = await makeTask({
      assignee: "Priya Raman",
      project: "web",
      createdBy: "human:krisz",
    });
    await prisma.taskLabel.create({ data: { taskId: web.id, label: "bug" } });
    const api = await makeTask({
      assignee: "Marcus Feld",
      project: "api",
      createdBy: "agent:claude-code",
    });
    await prisma.taskLabel.create({ data: { taskId: api.id, label: "perf" } });
    await makeTask({ assignee: "Marcus Feld", project: "web", createdBy: "human:krisz" });
    await makeTask({ assignee: null, project: null, createdBy: "agent:codex" });

    expect(await getTaskFacets()).toEqual({
      assignees: ["Marcus Feld", "Priya Raman"],
      projects: ["api", "web"],
      labels: ["bug", "perf"],
      creators: ["agent:claude-code", "agent:codex", "human:krisz"],
    });
  });

  it("returns empty lists when there are no tasks", async () => {
    expect(await getTaskFacets()).toEqual({
      assignees: [],
      projects: [],
      labels: [],
      creators: [],
    });
  });

  it("reflects a value cleared by a patch", async () => {
    const task = await makeTask({ project: "web" });

    await updateTask(task.id, updateInput({ project: "" }), HUMAN);

    expect((await getTaskFacets()).projects).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

describe("getTaskStats", () => {
  it("reports all ten statuses, zero included", async () => {
    const stats = await getTaskStats();

    expect(Object.keys(stats.byStatus).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.values(stats.byStatus).every((count) => count === 0)).toBe(true);
    expect(stats.needsAttention).toBe(0);
  });

  it("counts per status and sums everything waiting on a person into needsAttention", async () => {
    const blocker = await makeTask({ status: "todo" });
    await makeTask({ status: "todo" });
    await makeTask({ status: "needs_user_decision" });
    await makeTask({ status: "needs_user_action" });
    await makeTask({ status: "needs_qa" });
    await makeTask({ status: "needs_qa" });
    const blocked = await makeTask({ status: "blocked" });
    await makeDependency(blocked.id, blocker.id);

    const stats = await getTaskStats();

    expect(stats.byStatus).toMatchObject({
      todo: 2,
      needs_user_decision: 1,
      needs_user_action: 1,
      needs_qa: 2,
      blocked: 1,
      done: 0,
    });
    // `blocked` on an unfinished task waits on that task, not on a person.
    expect(stats.needsAttention).toBe(4);
  });

  it("counts only the given projects", async () => {
    await makeTask({ status: "todo", project: "web" });
    await makeTask({ status: "needs_qa", project: "api" });
    await makeTask({ status: "needs_qa", project: "infra" });
    await makeTask({ status: "todo", project: null });

    const stats = await getTaskStats(["web", "api"]);

    expect(stats.byStatus.todo).toBe(1);
    expect(stats.byStatus.needs_qa).toBe(1);
    expect(stats.needsAttention).toBe(1);
  });
});
