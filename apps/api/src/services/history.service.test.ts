import {
  createTaskInputSchema,
  historyQuerySchema,
  transitionInputSchema,
  type HistoryQuery,
} from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/errors.js";
import { makeEvent } from "../test/factories.js";
import { createTask } from "./task.service.js";
import { transitionTask } from "./task-workflow.service.js";
import { getTaskHistory } from "./history.service.js";

/**
 * `GET /stats/history` — `docs/features/History_Stats.md`.
 *
 * Simple bucket/metric cases are arranged directly with `makeEvent` (exact
 * ids, exact timestamps, no task needs to exist); the cases that depend on a
 * believable status sequence go through the real create/transition services.
 */

const HUMAN = "human:tester";
const AGENT = "agent:claude-code";

const history = (query: Partial<HistoryQuery> & Record<string, unknown> = {}) =>
  getTaskHistory(historyQuerySchema.parse(query));

const day = (n: number): Date => new Date(`2026-01-0${n}T00:00:00.000Z`);

describe("bucket boundaries", () => {
  it("counts a created event into the bucket containing its instant", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      payload: { status: "backlog", title: "x" },
      createdAt: day(2),
    });

    const result = await history({
      from: day(1).toISOString(),
      to: day(4).toISOString(),
      bucket: "day",
    });

    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0]?.created).toBe(0);
    expect(result.buckets[1]?.created).toBe(1);
    expect(result.buckets[2]?.created).toBe(0);
    expect(result.totals.created).toBe(1);
  });

  it("aligns from/to to bucket boundaries and echoes the aligned values", async () => {
    const result = await history({
      from: "2026-01-01T10:15:00Z",
      to: "2026-01-01T11:45:00Z",
      bucket: "hour",
    });

    expect(result.from).toBe("2026-01-01T10:00:00.000Z");
    expect(result.to).toBe("2026-01-01T12:00:00.000Z");
    expect(result.buckets).toHaveLength(2);
  });

  it("rejects a range producing more buckets than HISTORY_MAX_BUCKETS", async () => {
    await expect(
      history({ from: "2020-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z", bucket: "hour" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("aligns week buckets to Monday", async () => {
    // 2026-01-07 is a Wednesday.
    const result = await history({
      from: "2026-01-07T00:00:00Z",
      to: "2026-01-08T00:00:00Z",
      bucket: "week",
    });
    // Monday of that week is 2026-01-05.
    expect(result.from).toBe("2026-01-05T00:00:00.000Z");
  });
});

describe("statusCounts (the CFD)", () => {
  it("replays status from before the window and carries it into every later bucket", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      payload: { status: "backlog", title: "x" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      payload: { from: "backlog", to: "todo" },
      createdAt: day(1),
    });

    const result = await history({
      from: "2026-01-03T00:00:00Z",
      to: "2026-01-05T00:00:00Z",
      bucket: "day",
    });

    for (const bucket of result.buckets) expect(bucket.statusCounts.todo).toBe(1);
  });

  it("drops a task from every subsequent bucket once it is deleted", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      payload: { status: "backlog", title: "x" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 1,
      type: "task.deleted",
      payload: { title: "x" },
      createdAt: day(2),
    });

    const result = await history({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-04T00:00:00Z",
      bucket: "day",
    });

    expect(result.buckets[0]?.statusCounts.backlog).toBe(1);
    expect(result.buckets[1]?.statusCounts.backlog).toBe(0);
    expect(result.buckets[2]?.statusCounts.backlog).toBe(0);
  });
});

describe("completed / deferred / sentBack", () => {
  it("counts a needs_qa -> done transition as completed, and -> todo as sentBack", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      payload: { from: "in_progress", to: "needs_qa" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      payload: { from: "needs_qa", to: "done" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 2,
      type: "task.status_changed",
      payload: { from: "in_progress", to: "needs_qa" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 2,
      type: "task.status_changed",
      payload: { from: "needs_qa", to: "todo" },
      createdAt: day(1),
    });

    const result = await history({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      bucket: "day",
    });

    expect(result.totals.completed).toBe(1);
    expect(result.totals.sentBack).toBe(1);
    expect(result.totals.deferred).toBe(0);
  });
});

describe("cycle time", () => {
  it("measures in_progress -> needs_qa|done, attributed to the actor who moved it out", async () => {
    const { task } = await createTask(
      createTaskInputSchema.parse({
        title: "Add retries to the sender",
        description: "Long enough description for the schema.",
      }),
      HUMAN,
    );
    await transitionTask(task.id, transitionInputSchema.parse({ to: "in_progress" }), AGENT);
    await transitionTask(
      task.id,
      transitionInputSchema.parse({ to: "needs_qa", summary: "Done" }),
      AGENT,
    );

    const result = await history({ bucket: "day" });

    expect(result.cycleTimes).toHaveLength(1);
    expect(result.cycleTimes[0]).toMatchObject({ taskId: task.id, actor: AGENT });
    expect(result.cycleTimes[0]?.minutes).toBeGreaterThanOrEqual(0);
    expect(result.totals.cycleTime.count).toBe(1);
  });
});

describe("human wait", () => {
  it("records a stint that ended in range, and one still open as ongoing", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      payload: { from: "todo", to: "needs_user_decision" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      payload: { from: "needs_user_decision", to: "todo" },
      createdAt: day(2),
    });
    await makeEvent({
      taskId: 2,
      type: "task.status_changed",
      payload: { from: "todo", to: "needs_user_action" },
      createdAt: day(1),
    });

    const result = await history({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-03T00:00:00Z",
      bucket: "day",
    });

    const finished = result.longestWaits.find((w) => w.taskId === 1);
    const ongoing = result.longestWaits.find((w) => w.taskId === 2);
    expect(finished?.endedAt).not.toBeNull();
    expect(ongoing?.endedAt).toBeNull();
  });
});

describe("agents", () => {
  it("only lists actors starting agent:, most submitted first", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      actor: AGENT,
      payload: { from: "in_progress", to: "needs_qa" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 1,
      type: "task.status_changed",
      actor: HUMAN,
      payload: { from: "needs_qa", to: "done" },
      createdAt: day(1),
    });

    const result = await history({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      bucket: "day",
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ actor: AGENT, submitted: 1, approved: 1 });
  });
});

describe("project scope", () => {
  it("filters events by their recorded project", async () => {
    await makeEvent({
      taskId: 1,
      type: "task.created",
      project: "estuary",
      payload: { status: "backlog", title: "x" },
      createdAt: day(1),
    });
    await makeEvent({
      taskId: 2,
      type: "task.created",
      project: "billing",
      payload: { status: "backlog", title: "y" },
      createdAt: day(1),
    });

    const result = await history({
      project: ["estuary"],
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      bucket: "day",
    });

    expect(result.totals.created).toBe(1);
  });
});
